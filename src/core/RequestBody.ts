/**
 * Reading a request body without agreeing to hold whatever arrives.
 *
 * Both edge functions used to call `request.text()` and check the size
 * afterwards, which is a limit on what will be *parsed* and no limit at all on
 * what will be held: a client that sends a gigabyte had a gigabyte buffered
 * before being told the cap was 64 KB. Reading the stream a chunk at a time
 * stops at the first byte past the limit and cancels the reader, so nothing
 * further is pulled off the socket.
 *
 * Lives here rather than in `api/` so both functions can share it without
 * either importing the other — the same reason `Ticket.ts` is here. Nothing
 * in it touches the DOM or the game.
 */

/** A body that was read, or the reason it was not. */
export type BodyRead =
  | { ok: true; text: string }
  | { ok: false; reason: 'unreadable' | 'too-large' };

const encoder = new TextEncoder();

/**
 * The request body as text, refused the moment it goes past `limit` bytes.
 *
 * A runtime that hands back no stream at all falls through to `text()` under
 * the same limit — worse, but never wrong.
 */
export async function readBody(request: Request, limit: number): Promise<BodyRead> {
  const stream = request.body;
  if (!stream) {
    try {
      const text = await request.text();
      return encoder.encode(text).length > limit
        ? { ok: false, reason: 'too-large' }
        : { ok: true, text };
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
  }

  const reader = stream.getReader();
  // Streaming: a multi-byte character split across two chunks is decoded once
  // both halves have arrived, rather than becoming two replacement characters.
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        return { ok: false, reason: 'too-large' };
      }
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  parts.push(decoder.decode());
  return { ok: true, text: parts.join('') };
}
