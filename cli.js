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
      console.log(`Usage:
  node cli.js              Start a multi-turn conversation
  node cli.js --ask "..."  Send one prompt and exit

keytar:
  service: responses-test
  accounts: KEY, URL, MODEL`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  return args;
}

function getFunctionCalls(response) {
  return (response.output ?? []).filter((item) => item.type === 'function_call');
}

async function executeTool(call) {
  if (call.name !== 'list_dir') {
    throw new Error(`Unknown tool: ${call.name}`);
  }

  const names = await fs.readdir(process.cwd());
  return {
    cwd: process.cwd(),
    names,
  };
}

async function parseErrorResponse(response) {
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  const detail = data?.error?.message || text || response.statusText;
  throw new Error(`Responses API ${response.status}: ${detail}`);
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

  if (!response.ok) {
    await parseErrorResponse(response);
  }

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  if (!data || typeof data !== 'object') {
    throw new Error('Responses API returned invalid JSON');
  }

  return data;
}

async function requestStream(config, input, previousResponseId, onText) {
  const body = {
    model: config.model,
    input,
    tools: TOOLS,
    stream: true,
  };

  if (previousResponseId) {
    body.previous_response_id = previousResponseId;
  }

  const response = await fetch(config.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.key}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    await parseErrorResponse(response);
  }

  if (!response.body) {
    throw new Error('Responses API did not return a response body for streaming.');
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';
  let finalResponse = null;

  const handleEvent = (eventText) => {
    const dataLines = eventText
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());

    if (dataLines.length === 0) return;

    const dataText = dataLines.join('\n');
    if (dataText === '[DONE]') return;

    let event;
    try {
      event = JSON.parse(dataText);
    } catch {
      return;
    }

    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      onText(event.delta);
    }

    if (event.type === 'response.completed' && event.response) {
      finalResponse = event.response;
    }

    if (event.type === 'error') {
      throw new Error(event.message || event.error?.message || 'Responses API stream error');
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';

    for (const eventText of events) {
      handleEvent(eventText);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    handleEvent(buffer);
  }

  if (!finalResponse) {
    throw new Error('Responses API stream ended without response.completed.');
  }

  return finalResponse;
}

async function runConversation(config, input, previousResponseId, onText) {
  let response;

  // Stream the model response. If the model requests a tool, finish the current
  // response, execute the tool, then start another streamed response.
  response = await requestStream(config, input, previousResponseId, onText);

  while (true) {
    const calls = getFunctionCalls(response);
    if (calls.length === 0) {
      return response;
    }

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

    response = await requestStream(config, outputs, response.id, onText);
  }
}

async function singleTurn(config, prompt) {
  let printed = false;
  await runConversation(config, prompt, undefined, (delta) => {
    printed = true;
    process.stdout.write(delta);
  });

  if (!printed) {
    throw new Error('The response contains no text output.');
  }

  process.stdout.write('\n');
}

async function interactive(config) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  let previousResponseId;
  console.log('Multi-turn Responses CLI (streaming). Type /exit or Ctrl+C to quit.');
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
      let printed = false;
      const response = await runConversation(
        config,
        prompt,
        previousResponseId,
        (delta) => {
          printed = true;
          process.stdout.write(delta);
        },
      );

      if (!printed) {
        process.stdout.write('[No text output]');
      }
      process.stdout.write('\n');
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
