import type { Writable, Readable } from "node:stream";
export class Cdp {
  constructor(input: Writable, output: Readable);
  send(
    method: string,
    params?: Record<string, unknown>,
    deadline?: number,
  ): Promise<any>;
  evaluate(expression: string, deadline: number): Promise<any>;
}
