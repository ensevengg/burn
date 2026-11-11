/** Transport failures shared by every machine endpoint. */
export class LiveError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LiveError";
  }
}

export class LiveUnreachableError extends LiveError {
  constructor(message: string) {
    super(message);
    this.name = "LiveUnreachableError";
  }
}
