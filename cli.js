#!/usr/bin/env node

const fs = require('node:fs/promises');
const keytar = require('keytar');
const readline = require('node:readline');

const SERVICE = 'responses-test';

const TOOLS = [
  {
    type: 'function',
    name: 'list_dir',
    description: 'List the file and directory names in the current working directory.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
];

async function getConfig() {
  const [key, url, model] = await Promise.all([
    keytar.getPassword(SERVICE, 'KEY'),
    keytar.getPassword(SERVICE, 'URL'),
    keytar.getPassword(SERVICE, 'MODEL'),
  ]);

  const missing = [];
  if (!key) missing.push('KEY');
  if (!url) missing.push('URL');
  if (!model) missing.push('MODEL');

  if (missing.length) {
    throw new Error(
      `Missing keytar value(s): ${missing.join(', ')}. ` +
      `Store them with service "${SERVICE}" and accounts KEY, URL, MODEL.`,
    );
  }

  return { key, url, model };
}

function parseArgs(argv) {
  const args = { ask: null };

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--ask') {
      if (i + 1 >= argv.length) {
        throw new Error('--ask requires a prompt');
      }
      args.ask = argv[++i];
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(`Usage:\n  node cli.js              Start a multi-turn conversation\n  node cli.js --ask "..."  Send one prompt and exit\n\nkeytar:\n  service: responses-test\n  accounts: KEY, URL, MODEL`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  return args;
}

function extractText(response) {
  if (typeof response.output_text === 'string') {
    return response.output_text;
  }

  const parts = [];
  for (const item of response.output ?? []) {
    if (item.type !== 'message') continue;
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && typeof content.text === 'string') {
        parts.push(content.text);
      }
    }
  }
  return parts.join('');
}

function getFunctionCalls(response) {
  return (response.output ?? []).filter((item) => item.type === 'function_call');
}

async function executeTool(call) {
  if (call.name !== 'list_dir') {
    throw new Error(`Unknown tool: ${call.name}`);
  }

  // Deliberately expose only the current working directory; the model cannot
  // supply an arbitrary path.
  const names = await fs.readdir(process.cwd());
  return {
    cwd: process.cwd(),
    names,
  };
}

async function request(config, input, previousResponseId) {
  const body = {
    model: config.model,
    input,
    tools: TOOLS,
  };

  if (previousResponseId) {
    body.previous_response_id = previousResponseId;
  }

  const response = await fetch(config.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  if (!response.ok) {
    const detail = data?.error?.message || text || response.statusText;
    throw new Error(`Responses API ${response.status}: ${detail}`);
  }

  if (!data || typeof data !== 'object') {
    throw new Error('Responses API returned invalid JSON');
  }

  return data;
}

async function runConversation(config, input) {
  let response = await request(config, input);

  // Keep resolving tool calls until the model produces a final response.
  while (true) {
    const calls = getFunctionCalls(response);
    if (calls.length === 0) {
      return response;
    }

    const outputs = [];
    for (const call of calls) {
      let output;
      try {
        // Validate that the model sent valid JSON even though list_dir takes no args.
        JSON.parse(call.arguments || '{}');
        output = await executeTool(call);
      } catch (error) {
        output = { error: error.message };
      }

      outputs.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(output),
      });
    }

    response = await request(config, outputs, response.id);
  }
}

async function singleTurn(config, prompt) {
  const response = await runConversation(config, prompt);
  const output = extractText(response);
  if (!output) {
    throw new Error('The response contains no text output.');
  }
  process.stdout.write(`${output}\n`);
}

async function interactive(config) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  let previousResponseId;
  console.log('Multi-turn Responses CLI. Type /exit or Ctrl+C to quit.');
  rl.prompt();

  for await (const line of rl) {
    const prompt = line.trim();
    if (!prompt) {
      rl.prompt();
      continue;
    }
    if (prompt === '/exit' || prompt === '/quit') {
      break;
    }

    try {
      let response = await request(config, prompt, previousResponseId);

      while (true) {
        const calls = getFunctionCalls(response);
        if (calls.length === 0) break;

        const outputs = [];
        for (const call of calls) {
          let output;
          try {
            JSON.parse(call.arguments || '{}');
            output = await executeTool(call);
          } catch (error) {
            output = { error: error.message };
          }
          outputs.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: JSON.stringify(output),
          });
        }

        response = await request(config, outputs, response.id);
      }

      const output = extractText(response);
      if (!output) {
        console.log('[No text output]');
      } else {
        console.log(output);
      }
      previousResponseId = response.id;
    } catch (error) {
      console.error(`Error: ${error.message}`);
    }

    rl.prompt();
  }

  rl.close();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await getConfig();

  if (args.ask !== null) {
    await singleTurn(config, args.ask);
  } else {
    await interactive(config);
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
