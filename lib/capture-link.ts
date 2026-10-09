import "server-only";

import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import dns from "node:dns";
import net from "node:net";
import TurndownService from "turndown";
import { Agent, fetch } from "undici";

import { anthropic, FALLBACK_PARAMS, MODEL } from "@/lib/anthropic";
import { pickSuggestedLinks, type SuggestedLink } from "@/lib/links";

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

// Private, loopback, link-local and other non-public ranges. Fetching a link
// must never reach the server's own network (SSRF).
const blocked = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  blocked.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(address, prefix, "ipv6");
}

function isBlockedAddress(address: string, family: number) {
  if (family === 6 && address.toLowerCase().startsWith("::ffff:")) {
    const v4 = address.slice(7);
    if (net.isIPv4(v4)) return blocked.check(v4, "ipv4");
  }
  return blocked.check(address, family === 6 ? "ipv6" : "ipv4");
}

// Checks the address at connect time, so a hostname can't pass a check and
// then re-resolve to a private address (DNS rebinding).
const agent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dns.lookup(hostname, { all: true }, (error, addresses) => {
        if (error) return callback(error, "", 4);
        const allowed = addresses.filter(
          (a) => !isBlockedAddress(a.address, a.family),
        );
        if (allowed.length === 0) {
          return callback(
            new Error(`${hostname} resolves to a private address`),
            "",
            4,
          );
        }
        if ((options as dns.LookupOptions).all) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (callback as any)(null, allowed);
        }
        callback(null, allowed[0].address, allowed[0].family);
      });
    },
  },
});

/** A problem with the link itself, so retrying won't help. */
export class LinkError extends Error {}

export function parsePublicUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new LinkError("That doesn't look like a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LinkError("Only http and https links can be saved.");
  }
  if (url.username || url.password) {
    throw new LinkError("Links with embedded credentials can't be saved.");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new LinkError("Links on non-standard ports can't be saved.");
  }
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, ""))) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isBlockedAddress(host, net.isIPv6(host) ? 6 : 4)) {
      throw new LinkError("Links to private addresses can't be saved.");
    }
  }
  return url;
}

async function readCapped(response: Response | Awaited<ReturnType<typeof fetch>>) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new LinkError("The page is larger than 5 MB.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// [text](https://...) links in the markdown returned by Claude's web fetch.
const MARKDOWN_LINK = /\[([^\[\]]*)\]\((https?:\/\/[^)\s]+)\)/g;

/** The site refused an automated request, for example with a bot challenge. */
export class BlockedError extends Error {}

export type CapturedPage = {
  finalUrl: string;
  title: string;
  html: string | null; // null when fetched through Claude, which returns text only
  markdown: string;
  links: SuggestedLink[];
};

/**
 * Fetches a page through Claude's web fetch tool, which runs on Anthropic's
 * servers. Used when a site blocks direct requests from this server.
 */
export async function captureLinkViaClaude(input: string): Promise<CapturedPage> {
  const url = parsePublicUrl(input);
  const response = await anthropic().beta.messages.create({
    ...FALLBACK_PARAMS,
    model: MODEL,
    max_tokens: 1024,
    output_config: { effort: "low" },
    tools: [{ type: "web_fetch_20260209", name: "web_fetch", max_uses: 1 }],
    messages: [
      {
        role: "user",
        content: `Fetch ${url} with the web_fetch tool. After the fetch, reply with only "done".`,
      },
    ],
  });

  const result = response.content.find((b) => b.type === "web_fetch_tool_result");
  if (!result) throw new Error("The page couldn't be fetched.");
  if (result.content.type === "web_fetch_tool_result_error") {
    const code = result.content.error_code;
    if (code === "unsupported_content_type") {
      throw new LinkError(
        "This link isn't a web page. Download the file and upload it instead.",
      );
    }
    throw new LinkError(`The site couldn't be reached (${code.replaceAll("_", " ")}).`);
  }

  const { source, title } = result.content.content;
  if (source.type !== "text") {
    throw new LinkError(
      "This link isn't a web page. Download the file and upload it instead.",
    );
  }
  const markdown = source.data.trim();
  if (!markdown) throw new LinkError("No readable text was found on this page.");

  return {
    finalUrl: result.content.url,
    title: title?.trim() || url.hostname,
    html: null,
    markdown,
    links: pickSuggestedLinks(
      result.content.url,
      Array.from(markdown.matchAll(MARKDOWN_LINK), ([, text, href]) => ({ url: href, text })),
    ),
  };
}

/** Fetches a public web page and extracts its main content as markdown. */
export async function captureLink(input: string): Promise<CapturedPage> {
  let url = parsePublicUrl(input);
  const signal = AbortSignal.timeout(TIMEOUT_MS);

  for (let hop = 0; ; hop++) {
    const response = await fetch(url, {
      dispatcher: agent,
      redirect: "manual",
      signal,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; ProjectHub/1.0)",
        accept: "text/html,application/xhtml+xml",
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || hop >= MAX_REDIRECTS) {
        throw new LinkError("The link redirected too many times.");
      }
      url = parsePublicUrl(new URL(location, url).toString());
      continue;
    }
    if (
      response.headers.has("cf-mitigated") ||
      [401, 403, 429].includes(response.status)
    ) {
      throw new BlockedError(`The site blocked the request (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      const message = `The page returned HTTP ${response.status}.`;
      throw response.status >= 500 ? new Error(message) : new LinkError(message);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml\+xml/.test(contentType)) {
      throw new LinkError(
        "This link isn't a web page. Download the file and upload it instead.",
      );
    }

    const html = await readCapped(response);
    const dom = new JSDOM(html, { url: url.toString() });
    // Collect links before Readability, which strips navigation from the DOM.
    const links = pickSuggestedLinks(
      url.toString(),
      Array.from(dom.window.document.querySelectorAll("a[href]"), (a) => ({
        url: a.getAttribute("href") ?? "",
        text: a.textContent ?? "",
      })),
    );
    const article = new Readability(dom.window.document).parse();
    // Keep the text only: image and link markup costs tokens without helping answers.
    const turndown = new TurndownService({ headingStyle: "atx" })
      .remove(["script", "style", "noscript"])
      .addRule("noImages", { filter: ["img", "picture"], replacement: () => "" })
      .addRule("plainLinks", { filter: "a", replacement: (content) => content });
    const markdown = turndown
      .turndown(article?.content ?? dom.window.document.body?.innerHTML ?? "")
      .trim();

    if (!markdown) {
      throw new LinkError(
        "No readable text was found on this page. It may need JavaScript to render.",
      );
    }

    return {
      finalUrl: url.toString(),
      title: article?.title?.trim() || dom.window.document.title || url.hostname,
      html,
      markdown,
      links,
    };
  }
}
