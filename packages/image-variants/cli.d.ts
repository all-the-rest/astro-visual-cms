export interface RunCliOptions {
  cwd?: string
  stdout?: { write(chunk: string): unknown }
  stderr?: { write(chunk: string): unknown }
}

/** Run the CLI command parser. Resolves to the process exit code. */
export function runCli(argv?: string[], options?: RunCliOptions): Promise<number>
