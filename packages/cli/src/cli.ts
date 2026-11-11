const USAGE = `Usage: codeinsight <command> [options]

Commands:
  index     Build the index for the working tree or a commit
  review    Review changes between two versions
  similar   Find duplicate implementations
  serve     Start the local web UI / HTTP API
  mcp       Start the MCP server over stdio
`;

export async function runCli(argv: string[]): Promise<number> {
  const [command] = argv;
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  process.stderr.write(`unknown command: ${command}\n${USAGE}`);
  return 1;
}
