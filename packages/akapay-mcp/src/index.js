import readline from 'node:readline';
import { TOOLS, verifyWebhookSignature, generateBankSmsText, checkPortHealth } from './tools.js';

export class AkaPayMcpServer {
  constructor() {
    this.name = 'akapay-mcp-server';
    this.version = '1.0.0';
    this.tools = TOOLS;
  }

  async handleRequest(request) {
    const { id, method, params } = request;

    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: this.name, version: this.version }
          }
        };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: { tools: this.tools }
        };

      case 'tools/call':
        return this.handleToolCall(id, params);

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` }
        };
    }
  }

  async handleToolCall(id, params) {
    const { name, arguments: args = {} } = params;

    switch (name) {
      case 'akapay_check_gateway_health': {
        const ports = [6100, 7000, 6001, 6002, 6003];
        const results = await Promise.all(ports.map((p) => checkPortHealth(p, args.host)));
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] }
        };
      }

      case 'akapay_verify_webhook': {
        const result = verifyWebhookSignature(args);
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        };
      }

      case 'akapay_simulate_bank_notification': {
        const text = generateBankSmsText(args);
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text }] }
        };
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `Tool not found: ${name}` }
        };
    }
  }

  startStdio() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const req = JSON.parse(trimmed);
        const res = await this.handleRequest(req);
        process.stdout.write(JSON.stringify(res) + '\n');
      } catch (err) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      }
    });
  }
}

if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  const server = new AkaPayMcpServer();
  server.startStdio();
}
