export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

export class SseParser {
  private buffer = "";
  private dataLines: string[] = [];
  private eventName?: string;
  private eventId?: string;

  feed(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let newlineIndex: number;

    while ((newlineIndex = this.buffer.search(/\r\n|\n|\r/)) >= 0) {
      const newlineLength = this.buffer.startsWith("\r\n", newlineIndex) ? 2 : 1;
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + newlineLength);
      if (line === "") {
        const event = this.flushEvent();
        if (event) events.push(event);
        continue;
      }
      if (line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
      if (field === "data") this.dataLines.push(value);
      else if (field === "event") this.eventName = value;
      else if (field === "id") this.eventId = value;
    }
    return events;
  }

  end(): SseEvent[] {
    if (this.buffer.length > 0) {
      this.buffer += "\n";
      const events = this.feed("");
      return events;
    }
    const event = this.flushEvent();
    return event ? [event] : [];
  }

  reset(): void {
    this.buffer = "";
    this.dataLines = [];
    this.eventName = undefined;
    this.eventId = undefined;
  }

  private flushEvent(): SseEvent | null {
    if (this.dataLines.length === 0) {
      this.eventName = undefined;
      this.eventId = undefined;
      return null;
    }
    const event: SseEvent = {
      data: this.dataLines.join("\n"),
      ...(this.eventName ? { event: this.eventName } : {}),
      ...(this.eventId ? { id: this.eventId } : {}),
    };
    this.dataLines = [];
    this.eventName = undefined;
    this.eventId = undefined;
    return event;
  }
}

export async function* readSseStream(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parser.feed(decoder.decode(value, { stream: true }))) yield event;
    }
    for (const event of parser.feed(decoder.decode())) yield event;
    for (const event of parser.end()) yield event;
  } finally {
    reader.releaseLock();
  }
}
