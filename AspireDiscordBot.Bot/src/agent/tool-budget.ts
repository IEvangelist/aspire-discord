export class ToolBudget {
  #remaining: number;

  public constructor(maximumCalls: number) {
    this.#remaining = maximumCalls;
  }

  public get remaining(): number {
    return this.#remaining;
  }

  public async invoke<T>(name: string, execute: () => Promise<T>): Promise<T | string> {
    if (this.#remaining <= 0) {
      return `Tool-call budget exhausted. Answer using the evidence already gathered; '${name}' was not executed.`;
    }
    this.#remaining -= 1;
    return await execute();
  }
}
