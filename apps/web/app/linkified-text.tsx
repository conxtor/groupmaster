import type { ReactNode } from "react";

const urlPattern = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;

function splitTrailingPunctuation(value: string) {
  let url = value;
  let trailing = "";

  while (/[.,!?;:]$/.test(url)) {
    trailing = url.slice(-1) + trailing;
    url = url.slice(0, -1);
  }

  for (const [opening, closing] of [["(", ")"], ["[", "]"], ["{", "}"]] as const) {
    while (url.endsWith(closing) && (url.match(new RegExp(`\\${closing}`, "g"))?.length ?? 0) > (url.match(new RegExp(`\\${opening}`, "g"))?.length ?? 0)) {
      trailing = closing + trailing;
      url = url.slice(0, -1);
    }
  }

  return { url, trailing };
}

function safeHref(value: string) {
  const candidate = value.startsWith("www.") ? `https://${value}` : value;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

export function LinkifiedText({ text }: { text: string }): ReactNode {
  const children: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let linkIndex = 0;

  while ((match = urlPattern.exec(text)) !== null) {
    children.push(text.slice(lastIndex, match.index));
    const { url, trailing } = splitTrailingPunctuation(match[0]);
    const href = safeHref(url);
    if (!href) {
      children.push(match[0]);
    } else {
      children.push(<a key={`link-${linkIndex++}`} href={href} target="_blank" rel="noopener noreferrer">{url}</a>);
      children.push(trailing);
    }
    lastIndex = match.index + match[0].length;
  }

  children.push(text.slice(lastIndex));
  return <>{children}</>;
}
