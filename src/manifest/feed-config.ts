// IA config (part of the local manifest): which event kinds each feed surface fetches. Declared as
// DATA here - colocated with the kind handlers - rather than hardcoded in the feed route, so "what
// kinds this client deals in" is config. The kinds correspond to registered render handlers (notes/
// polls → the note path; articles → the article handler). Cycle-free: imports only kind constants.

import { KIND_POLL } from '../nostr/nip88.ts';
import { KIND_ARTICLE } from '../nostr/nip23.ts';
import { KIND_PICTURE } from '../nostr/nip68.ts';

export const FEED_KINDS = {
    note: [1, KIND_POLL, KIND_PICTURE] as number[], // timeline feeds (following/followers/commons): notes + polls + NIP-68 pictures (1, 1068, 20)
    longform: [KIND_ARTICLE] as number[], // the longform feed (30023)
};
