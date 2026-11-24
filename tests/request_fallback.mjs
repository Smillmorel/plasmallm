#!/usr/bin/env node
import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function load(name) {
    let code = fs.readFileSync(path.join(__dirname, "../package/contents/ui", name), "utf8");
    code = code.replace(/^\s*\.(import|pragma)\s+.*$/gm, "");
    const sandbox = { console, Math };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox;
}

const Utils = load("utils.js");

// Fresh module per scenario so the rejected-model cache starts empty.
function loadFallback() {
    let code = fs.readFileSync(
        path.join(__dirname, "../package/contents/ui/adapters/requestFallback.js"),
        "utf8"
    );
    code = code.replace(/^\s*\.(import|pragma)\s+.*$/gm, "");
    const sandbox = {
        console: Object.assign({}, console, { warn: function() {} }),
        Utils: Utils,
        i18n: function(s) { return s; }
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox;
}

// Adapter stub that records each request and lets the test drive callbacks.
function makeAdapter() {
    const calls = [];
    return {
        calls: calls,
        sendStreaming: function(opts) {
            const xhr = { aborted: false, abort: function() { this.aborted = true; } };
            const handle = {
                xhr: xhr,
                setPollTimer: function(timer) { this.pollTimer = timer; },
                processBuffer: function() { this.processed = true; }
            };
            calls.push({ opts: opts, xhr: xhr, handle: handle });
            return handle;
        }
    };
}

function baseOpts(extra) {
    return Object.assign({
        endpoint: "https://example.test/v1",
        model: "gpt-6-luna",
        temperature: 70,
        messages: [],
        onChunk: function() {},
        onThinkingChunk: function() {},
        onComplete: function() {}
    }, extra || {});
}

const UNSUPPORTED = "API error 400: Unsupported parameter: 'temperature' is not supported with this model.";
const DEPRECATED = "API error 400: Upstream request failed: [invalid_request_error] `temperature` is deprecated for this model.";

let failed = 0;
function ok(cond, msg) {
    if (!cond) {
        failed++;
        console.error("FAIL", msg);
    }
}

// 1. Rejection before any output: retry once without temperature.
{
    const Fallback = loadFallback();
    const adapter = makeAdapter();
    const chunks = [];
    const completions = [];
    const handle = Fallback.send(adapter, baseOpts({
        onChunk: function(delta, acc) { chunks.push(delta); },
        onComplete: function(text, error) { completions.push({ text: text, error: error }); }
    }));

    ok(adapter.calls.length === 1, "first attempt issued immediately");
    ok(adapter.calls[0].opts.temperature === 70, "first attempt sends temperature");

    adapter.calls[0].opts.onComplete("", UNSUPPORTED);
    ok(adapter.calls.length === 2, "rejection triggers a retry");
    ok(adapter.calls[1].opts.temperature === undefined, "retry omits temperature");
    ok(handle.xhr === adapter.calls[1].xhr, "handle points at the retry xhr");

    adapter.calls[1].opts.onChunk("hello", "hello");
    adapter.calls[1].opts.onComplete("hello", null, null, null);
    ok(chunks.length === 1 && chunks[0] === "hello", "chunks reach the caller once");
    ok(completions.length === 1 && completions[0].text === "hello" && completions[0].error === null,
       "caller sees only the successful completion");
}

// 2. Remembered rejection: later requests skip temperature from the start.
{
    const Fallback = loadFallback();
    const adapter1 = makeAdapter();
    Fallback.send(adapter1, baseOpts());
    adapter1.calls[0].opts.onComplete("", DEPRECATED);

    const adapter2 = makeAdapter();
    const handle2 = Fallback.send(adapter2, baseOpts({ model: "gpt-6-luna" }));
    ok(adapter2.calls.length === 1, "second send issues one request");
    ok(adapter2.calls[0].opts.temperature === undefined, "known-rejecting model skips temperature");
    ok(handle2.xhr === adapter2.calls[0].xhr, "handle exposes the xhr");

    const adapter3 = makeAdapter();
    Fallback.send(adapter3, baseOpts({ model: "other-model" }));
    ok(adapter3.calls[0].opts.temperature === 70, "other models keep temperature");
}

// 3. Once output has streamed, a late error is reported, not retried.
{
    const Fallback = loadFallback();
    const adapter = makeAdapter();
    const completions = [];
    Fallback.send(adapter, baseOpts({
        onComplete: function(text, error) { completions.push({ text: text, error: error }); }
    }));
    adapter.calls[0].opts.onChunk("partial", "partial");
    adapter.calls[0].opts.onComplete("partial", UNSUPPORTED);
    ok(adapter.calls.length === 1, "no retry after content was streamed");
    ok(completions.length === 1 && completions[0].error === UNSUPPORTED, "error is reported");
}

// 4. Unrelated errors pass through unchanged.
{
    const Fallback = loadFallback();
    const adapter = makeAdapter();
    const completions = [];
    Fallback.send(adapter, baseOpts({
        onComplete: function(text, error) { completions.push({ text: text, error: error }); }
    }));
    const err = "API error 429: Rate limited";
    adapter.calls[0].opts.onComplete("", err);
    ok(adapter.calls.length === 1, "non-temperature error is not retried");
    ok(completions.length === 1 && completions[0].error === err, "error reaches the caller");
}

// 5. Handle delegates timer, buffer and abort to the current attempt.
{
    const Fallback = loadFallback();
    const adapter = makeAdapter();
    const handle = Fallback.send(adapter, baseOpts());

    const timer = {
        running: false,
        starts: 0,
        start: function() { this.running = true; this.starts++; },
        stop: function() { this.running = false; }
    };
    handle.setPollTimer(timer);
    ok(adapter.calls[0].handle.pollTimer === timer, "timer forwarded to the first attempt");

    handle.processBuffer();
    ok(adapter.calls[0].handle.processed === true, "processBuffer delegated");

    adapter.calls[0].opts.onComplete("", UNSUPPORTED);
    ok(adapter.calls[1].handle.pollTimer === timer, "timer forwarded to the retry");
    ok(timer.starts === 1, "poll timer restarted for the retry");

    handle.abort();
    ok(adapter.calls[1].xhr.aborted === true, "abort hits the retry xhr");
    const before = adapter.calls.length;
    adapter.calls[1].opts.onComplete("", UNSUPPORTED);
    ok(adapter.calls.length === before, "aborted requests do not retry");
}

// 6. Requests without temperature bypass the wrapper entirely.
{
    const Fallback = loadFallback();
    const adapter = makeAdapter();
    const opts = baseOpts();
    delete opts.temperature;
    const handle = Fallback.send(adapter, opts);
    ok(adapter.calls.length === 1, "temperature-free request issued once");
    ok(handle === adapter.calls[0].handle, "raw adapter handle returned");
}

// 7. Integration: the real Responses adapter, driven through the wrapper,
//    drops temperature from the retried request body.
{
    const requests = [];
    class FakeXHR {
        constructor() { this.headers = {}; }
        open(method, url) { this.method = method; this.url = url; }
        setRequestHeader(k, v) { this.headers[k] = v; }
        send(body) { this.body = body; requests.push(this); }
        abort() { this.respond(0, ""); }
        respond(status, body) {
            this.status = status;
            this.responseText = body;
            this.readyState = 4;
            if (this.onreadystatechange) this.onreadystatechange();
        }
    }

    let adapterCode = fs.readFileSync(
        path.join(__dirname, "../package/contents/ui/adapters/openai_responses.js"),
        "utf8"
    );
    adapterCode = adapterCode.replace(/^\s*\.(import|pragma)\s+.*$/gm, "");
    const sandbox = {
        console: Object.assign({}, console, { warn: function() {}, error: function() {} }),
        XMLHttpRequest: FakeXHR,
        Utils: Utils,
        ToolManager: {},
        i18n: function(s) {
            const args = Array.prototype.slice.call(arguments, 1);
            return s.replace(/%(\d)/g, function(m, n) { return String(args[n - 1]); });
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(adapterCode, sandbox);

    const Fallback = loadFallback();
    const chunks = [];
    const completions = [];
    Fallback.send(sandbox, baseOpts({
        usesResponsesAPI: true,
        messages: [{ role: "user", content: "hi" }],
        onChunk: function(delta) { chunks.push(delta); },
        onComplete: function(text, error) { completions.push({ text: text, error: error }); }
    }));

    ok(requests.length === 1, "integration: first request sent");
    ok(JSON.parse(requests[0].body).temperature === 0.7, "integration: first body carries temperature");

    requests[0].respond(400, JSON.stringify({
        error: { message: "Unsupported parameter: 'temperature' is not supported with this model." }
    }));
    ok(requests.length === 2, "integration: 400 triggers a retry");
    ok(!("temperature" in JSON.parse(requests[1].body)), "integration: retry body omits temperature");

    requests[1].respond(200,
        'data: {"type":"response.output_text.delta","delta":"OK"}\n\n' +
        'data: {"type":"response.completed"}\n\n');
    ok(chunks.join("") === "OK", "integration: retried response streams to the caller");
    ok(completions.length === 1 && completions[0].error === null && completions[0].text === "OK",
       "integration: caller sees a successful completion");
}

// 8. Integration: the Anthropic adapter handles the "deprecated" wording
//    Claude Haiku 5.x returns; the retried message request omits temperature.
{
    const requests = [];
    class FakeXHR {
        constructor() { this.headers = {}; }
        open(method, url) { this.method = method; this.url = url; }
        setRequestHeader(k, v) { this.headers[k] = v; }
        send(body) { this.body = body; requests.push(this); }
        abort() { this.respond(0, ""); }
        respond(status, body) {
            this.status = status;
            this.responseText = body;
            this.readyState = 4;
            if (this.onreadystatechange) this.onreadystatechange();
        }
    }

    let adapterCode = fs.readFileSync(
        path.join(__dirname, "../package/contents/ui/adapters/anthropic.js"),
        "utf8"
    );
    adapterCode = adapterCode.replace(/^\s*\.(import|pragma)\s+.*$/gm, "");
    const sandbox = {
        console: Object.assign({}, console, { warn: function() {}, error: function() {} }),
        XMLHttpRequest: FakeXHR,
        ToolManager: {},
        i18n: function(s) {
            const args = Array.prototype.slice.call(arguments, 1);
            return s.replace(/%(\d)/g, function(m, n) { return String(args[n - 1]); });
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(adapterCode, sandbox);

    const Fallback = loadFallback();
    const completions = [];
    Fallback.send(sandbox, baseOpts({
        endpoint: "https://opencode.example/zen/go/v1",
        model: "claude-haiku-5-5",
        apiKey: "test-key",
        maxTokens: 128,
        messages: [{ role: "user", content: "hi" }],
        extraHeaders: { "x-opencode-session": "test" },
        onComplete: function(text, error) { completions.push({ text: text, error: error }); }
    }));

    ok(requests.length === 1, "anthropic: first request sent");
    ok(requests[0].url.indexOf("/messages") !== -1, "anthropic: messages endpoint");
    ok(JSON.parse(requests[0].body).temperature === 0.7, "anthropic: first body carries temperature");

    requests[0].respond(400, JSON.stringify({
        type: "error",
        error: {
            type: "invalid_request_error",
            message: "Upstream request failed: [invalid_request_error] `temperature` is deprecated for this model."
        }
    }));
    ok(requests.length === 2, "anthropic: 400 triggers a retry");
    ok(!("temperature" in JSON.parse(requests[1].body)), "anthropic: retry body omits temperature");

    requests[1].respond(200, JSON.stringify({
        content: [{ type: "text", text: "OK" }]
    }));
    ok(completions.length === 1 && completions[0].error === null && completions[0].text === "OK",
       "anthropic: caller sees a successful completion");
}

// 9. Anthropic with extended thinking forces temperature=1; the retry must
//    still drop it (newer models reject it even when thinking is enabled).
{
    const requests = [];
    class FakeXHR {
        constructor() { this.headers = {}; }
        open(method, url) { this.method = method; this.url = url; }
        setRequestHeader(k, v) { this.headers[k] = v; }
        send(body) { this.body = body; requests.push(this); }
        abort() { this.respond(0, ""); }
        respond(status, body) {
            this.status = status;
            this.responseText = body;
            this.readyState = 4;
            if (this.onreadystatechange) this.onreadystatechange();
        }
    }

    let adapterCode = fs.readFileSync(
        path.join(__dirname, "../package/contents/ui/adapters/anthropic.js"),
        "utf8"
    );
    adapterCode = adapterCode.replace(/^\s*\.(import|pragma)\s+.*$/gm, "");
    const sandbox = {
        console: Object.assign({}, console, { warn: function() {}, error: function() {} }),
        XMLHttpRequest: FakeXHR,
        ToolManager: {},
        i18n: function(s) {
            const args = Array.prototype.slice.call(arguments, 1);
            return s.replace(/%(\d)/g, function(m, n) { return String(args[n - 1]); });
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(adapterCode, sandbox);

    const Fallback = loadFallback();
    Fallback.send(sandbox, baseOpts({
        endpoint: "https://api.anthropic.test",
        model: "claude-haiku-5-5",
        apiKey: "test-key",
        maxTokens: 128,
        reasoningEffort: "high",
        thinkingBudget: 1024,
        messages: [{ role: "user", content: "hi" }],
        onComplete: function() {}
    }));

    ok(JSON.parse(requests[0].body).temperature === 1, "thinking: first body forces temperature 1");
    requests[0].respond(400, JSON.stringify({
        error: { message: "`temperature` is deprecated for this model." }
    }));
    ok(requests.length === 2, "thinking: 400 triggers a retry");
    const retryBody = JSON.parse(requests[1].body);
    ok(!("temperature" in retryBody), "thinking: retry omits the forced temperature");
    ok(retryBody.thinking && retryBody.thinking.type === "enabled", "thinking: retry keeps thinking config");
}

// 10. Truncated tool call: retry once with a larger output budget.
{
    const Fallback = loadFallback();
    const adapter = makeAdapter();
    const completions = [];
    Fallback.send(adapter, baseOpts({
        maxTokens: 2048,
        onComplete: function(text, error) { completions.push({ text: text, error: error }); }
    }));

    ok(adapter.calls[0].opts.maxTokens === 2048, "budget: first attempt uses configured maxTokens");
    adapter.calls[0].opts.onComplete("", "API error 500: Failed to parse tool call arguments as JSON: missing closing quote");
    ok(adapter.calls.length === 2, "budget: parse failure triggers a retry");
    ok(adapter.calls[1].opts.maxTokens === 8192, "budget: retry raises maxTokens to 8192");
    ok(adapter.calls[1].opts.temperature === 70, "budget: retry keeps temperature");

    adapter.calls[1].opts.onComplete("done", null, null, null);
    ok(completions.length === 1 && completions[0].text === "done", "budget: caller sees the retry result");
}

// 11. A second truncation is reported with actionable guidance and the
//     multi-kilobyte argument dump is trimmed.
{
    const Fallback = loadFallback();
    const adapter = makeAdapter();
    const completions = [];
    const dump = "API error 500: Failed to parse tool call arguments as JSON: parse error at line 1, column 3797: " +
                 "invalid string: missing closing quote; last read: '\"python3 << 'EOF'\\n" + "x".repeat(3000);
    Fallback.send(adapter, baseOpts({
        maxTokens: 2048,
        onComplete: function(text, error) { completions.push({ text: text, error: error }); }
    }));
    adapter.calls[0].opts.onComplete("", dump);
    ok(adapter.calls.length === 2, "guidance: first truncation retried");
    adapter.calls[1].opts.onComplete("", dump);
    ok(adapter.calls.length === 2, "guidance: only one budget retry");
    ok(completions.length === 1, "guidance: caller notified once");
    const err = completions[0].error || "";
    ok(err.indexOf("Raise Max Tokens") !== -1, "guidance: tells the user to raise Max Tokens");
    ok(err.indexOf("x".repeat(3000)) === -1, "guidance: argument dump trimmed");
    ok(err.indexOf("(tool-call arguments truncated)") !== -1, "guidance: marks the truncation");
}

// 12. Already at the budget cap (or no maxTokens): no retry, just guidance.
{
    const Fallback = loadFallback();
    const adapter = makeAdapter();
    const completions = [];
    Fallback.send(adapter, baseOpts({
        maxTokens: 16384,
        onComplete: function(text, error) { completions.push({ text: text, error: error }); }
    }));
    adapter.calls[0].opts.onComplete("", "Failed to parse tool call arguments as JSON");
    ok(adapter.calls.length === 1, "cap: no retry at 16384");
    ok(completions.length === 1 && (completions[0].error || "").indexOf("Raise Max Tokens") !== -1,
       "cap: guidance still shown");

    const Fallback2 = loadFallback();
    const adapter2 = makeAdapter();
    const opts2 = baseOpts();
    delete opts2.maxTokens;
    Fallback2.send(adapter2, opts2);
    adapter2.calls[0].opts.onComplete("", "Failed to parse tool call arguments as JSON");
    ok(adapter2.calls.length === 1, "no maxTokens: no budget retry");
}

// 13. Both rules can apply to one request: temperature first, then truncation.
{
    const Fallback = loadFallback();
    const adapter = makeAdapter();
    const completions = [];
    Fallback.send(adapter, baseOpts({
        maxTokens: 2048,
        onComplete: function(text, error) { completions.push({ text: text, error: error }); }
    }));
    adapter.calls[0].opts.onComplete("", UNSUPPORTED);
    ok(adapter.calls.length === 2 && adapter.calls[1].opts.temperature === undefined,
       "combined: temperature retry first");
    adapter.calls[1].opts.onComplete("", "Failed to parse tool call arguments as JSON");
    ok(adapter.calls.length === 3, "combined: truncation retry follows");
    ok(adapter.calls[2].opts.temperature === undefined, "combined: still skipping temperature");
    ok(adapter.calls[2].opts.maxTokens === 8192, "combined: larger budget applied");
    ok(adapter.calls[2].opts.skipTemperature === true, "combined: skip flag preserved");
    adapter.calls[2].opts.onComplete("ok", null, null, null);
    ok(completions.length === 1 && completions[0].error === null, "combined: success reported once");
}

// 14. Integration: truncated tool-call 500 from the Responses adapter raises
//     max_output_tokens on the retried request.
{
    const requests = [];
    class FakeXHR {
        constructor() { this.headers = {}; }
        open(method, url) { this.method = method; this.url = url; }
        setRequestHeader(k, v) { this.headers[k] = v; }
        send(body) { this.body = body; requests.push(this); }
        abort() { this.respond(0, ""); }
        respond(status, body) {
            this.status = status;
            this.responseText = body;
            this.readyState = 4;
            if (this.onreadystatechange) this.onreadystatechange();
        }
    }

    let adapterCode = fs.readFileSync(
        path.join(__dirname, "../package/contents/ui/adapters/openai_responses.js"),
        "utf8"
    );
    adapterCode = adapterCode.replace(/^\s*\.(import|pragma)\s+.*$/gm, "");
    const sandbox = {
        console: Object.assign({}, console, { warn: function() {}, error: function() {} }),
        XMLHttpRequest: FakeXHR,
        Utils: Utils,
        ToolManager: {},
        i18n: function(s) {
            const args = Array.prototype.slice.call(arguments, 1);
            return s.replace(/%(\d)/g, function(m, n) { return String(args[n - 1]); });
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(adapterCode, sandbox);

    const Fallback = loadFallback();
    const chunks = [];
    const completions = [];
    Fallback.send(sandbox, baseOpts({
        usesResponsesAPI: true,
        maxTokens: 2048,
        messages: [{ role: "user", content: "rewrite the config" }],
        onChunk: function(delta) { chunks.push(delta); },
        onComplete: function(text, error) { completions.push({ text: text, error: error }); }
    }));

    ok(JSON.parse(requests[0].body).max_output_tokens === 2048, "integration: first body uses 2048");
    requests[0].respond(500, JSON.stringify({
        error: { message: "Failed to parse tool call arguments as JSON: [json.exception.parse_error.101] " +
                          "parse error at line 1, column 3797: invalid string: missing closing quote" }
    }));
    ok(requests.length === 2, "integration: 500 triggers a retry");
    ok(JSON.parse(requests[1].body).max_output_tokens === 8192, "integration: retry body uses 8192");

    requests[1].respond(200,
        'data: {"type":"response.output_text.delta","delta":"OK"}\n\n' +
        'data: {"type":"response.completed"}\n\n');
    ok(chunks.join("") === "OK", "integration: retry streams to the caller");
    ok(completions.length === 1 && completions[0].error === null, "integration: success reported once");
}

if (failed > 0) {
    console.error(failed + " test(s) failed");
    process.exit(1);
}

console.log("request_fallback.mjs: all tests passed");
