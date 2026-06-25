// NIP-23 long-form articles (kind:30023). Addressable by naddr (kind:pubkey:d),
// body is Markdown. Pure metadata helpers - no DOM, no network.

import type { NostrEvent } from './types.ts';

export const KIND_ARTICLE = 30023;

export interface Article {
    title: string;
    summary: string;
    image: string;
    publishedAt: number; // first-publish time (falls back to created_at)
    identifier: string;  // the `d` slug
    topics: string[];
    content: string;     // markdown body
}

const tagVal = (ev: NostrEvent, name: string) => ev.tags.find((t) => t[0] === name)?.[1] ?? '';

export function parseArticle(ev: NostrEvent): Article {
    const published = Number(tagVal(ev, 'published_at'));
    return {
        title: tagVal(ev, 'title') || '(untitled)',
        summary: tagVal(ev, 'summary'),
        image: tagVal(ev, 'image'),
        publishedAt: Number.isFinite(published) && published > 0 ? published : ev.created_at,
        identifier: tagVal(ev, 'd'),
        topics: ev.tags.filter((t) => t[0] === 't' && t[1]).map((t) => t[1]!),
        content: ev.content,
    };
}

/** The addressable id `kind:pubkey:d` for an article event. */
export function articleAddress(ev: NostrEvent): string {
    return `${KIND_ARTICLE}:${ev.pubkey}:${tagVal(ev, 'd')}`;
}

/** Estimated reading time in whole minutes (≥1), at ~220 wpm. */
export function readingMinutes(markdown: string): number {
    const words = markdown.trim().split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(words / 220));
}
