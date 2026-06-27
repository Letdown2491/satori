// NIP-F4: Nostr-native podcasts. The renderable feed event is the EPISODE (kind 54): title/image/
// description/audio tags + markdown show-notes in content. (The NIP also defines podcast metadata
// 10154, authored 10064, and favorites 10054 - not rendered as cards, so not constants here yet.)
// Kind constant lives here, its NIP module, mirroring KIND_PICTURE (nip68) / KIND_POLL (nip88).
export const KIND_PODCAST_EPISODE = 54;
