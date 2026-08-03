export interface DiscourseTopicRef {
  origin: string;
  basePath: string;
  topicId: string;
  slug?: string;
  postNumber?: number;
  canonicalUrl: string;
}
/** Parse both hosted Discourse URLs (`/t/123`) and installations below a path (`/forum/t/slug/123`). */
export function parseDiscourseTopicUrl(value: string): DiscourseTopicRef | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const markerIndex = url.pathname.indexOf("/t/");
  if (markerIndex < 0) return undefined;
  const basePath = url.pathname.slice(0, markerIndex).replace(/\/+$/, "");
  const segments = url.pathname.slice(markerIndex + 3).split("/").filter(Boolean);
  if (!segments.length) return undefined;
  let slug: string | undefined;
  let topicId: string | undefined;
  if (/^\d+$/.test(segments[0])) {
    topicId = segments[0];
  } else if (segments.length >= 2 && /^\d+$/.test(segments[1])) {
    slug = safeDecode(segments[0]);
    topicId = segments[1];
  }
  if (!topicId || !/^\d+$/.test(topicId)) return undefined;
  const postNumber = segments[2] && /^\d+$/.test(segments[2]) ? Number(segments[2]) : undefined;
  if (segments.length > 3 || (segments[2] && postNumber === undefined)) return undefined;
  const topicPath = `${basePath}/t/${slug ? `${encodeURIComponent(slug)}/` : ""}${topicId}`;
  return {
    origin: url.origin,
    basePath,
    topicId,
    slug,
    postNumber,
    canonicalUrl: `${url.origin}${topicPath}${postNumber ? `/${postNumber}` : ""}`,
  };
}

export function discourseTopicJsonUrl(ref: DiscourseTopicRef, parameters: Record<string, string> = {}): string {
  const url = new URL(`${ref.origin}${ref.basePath}/t/${ref.topicId}.json`);
  Object.entries(parameters).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

export function discoursePostsUrl(ref: DiscourseTopicRef, postIds: readonly string[]): string {
  const url = new URL(`${ref.origin}${ref.basePath}/t/${ref.topicId}/posts.json`);
  url.searchParams.set("include_raw", "true");
  postIds.forEach((id) => url.searchParams.append("post_ids[]", id));
  return url.toString();
}

export function discourseRepliesUrl(ref: DiscourseTopicRef, postId: string): string {
  return `${ref.origin}${ref.basePath}/posts/${encodeURIComponent(postId)}/replies.json`;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
