import type { ProviderId, SummaryEvent, SummaryProvider, SummaryRequest } from "../../src/domain/types";

export class FakeProvider implements SummaryProvider {
  constructor(readonly id: ProviderId, private readonly output = "fake summary") {}

  async validateReady(): Promise<void> {}

  async *summarize(_request: SummaryRequest, signal: AbortSignal): AsyncIterable<SummaryEvent> {
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    yield { type: "phase", phase: "summarizing", current: 1, total: 1 };
    yield { type: "delta", text: this.output };
    yield { type: "done" };
  }
}
