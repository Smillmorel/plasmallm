/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

// Temperature fallback wrapper. Newer models reject the `temperature` field
// (OpenAI GPT-5/6 reasoning models: "Unsupported parameter: 'temperature' is
// not supported with this model"; Anthropic Claude Haiku 5.x: "temperature is
// deprecated for this model") and the request fails with HTTP 400 before any
// output. When that happens, retry once without the field and remember the
// endpoint/model so later requests skip it from the start.
//
// The returned handle matches the adapter handle surface main.qml relies on:
// `.xhr` (for abort), `setPollTimer(timer)` and `processBuffer()`.

.import "../utils.js" as Utils

var rejected = {};

function cacheKey(opts) {
    return String(opts.endpoint || "") + "|" + String(opts.model || "");
}

function copyWithoutTemperature(opts) {
    var o = {};
    for (var k in opts) {
        if (opts.hasOwnProperty(k))
            o[k] = opts[k];
    }
    delete o.temperature;
    return o;
}

function send(adapter, opts) {
    if (!opts || opts.temperature === undefined || opts.temperature === null)
        return adapter.sendStreaming(opts);

    var key = cacheKey(opts);
    if (rejected[key])
        return adapter.sendStreaming(copyWithoutTemperature(opts));

    var state = {
        attempt: null,
        timer: null,
        cancelled: false,
        streamed: false
    };
    var onChunk = opts.onChunk;
    var onThinkingChunk = opts.onThinkingChunk;
    var onComplete = opts.onComplete;

    function buildOpts(withoutTemperature) {
        var o = copyWithoutTemperature(opts);
        if (withoutTemperature) {
            // Adapters that force a temperature value (e.g. Anthropic with
            // extended thinking) must skip it too.
            o.skipTemperature = true;
        } else {
            o.temperature = opts.temperature;
        }
        o.onChunk = function(delta, accumulated) {
            state.streamed = true;
            if (onChunk) onChunk(delta, accumulated);
        };
        o.onThinkingChunk = function(delta, accumulated) {
            state.streamed = true;
            if (onThinkingChunk) onThinkingChunk(delta, accumulated);
        };
        o.onComplete = function(text, error, toolCalls, message) {
            if (error && !withoutTemperature && !state.cancelled && !state.streamed
                    && Utils.isUnsupportedTemperatureError(error)) {
                rejected[key] = true;
                console.warn("PlasmaLLM: model '" + (opts.model || "?") +
                             "' rejected the temperature parameter; retrying without it");
                start(true);
                return;
            }
            if (onComplete) onComplete(text, error, toolCalls, message);
        };
        return o;
    }

    function start(withoutTemperature) {
        state.attempt = adapter.sendStreaming(buildOpts(withoutTemperature));
        handle.xhr = state.attempt ? state.attempt.xhr : null;
        if (state.timer && state.attempt && typeof state.attempt.setPollTimer === "function")
            state.attempt.setPollTimer(state.timer);
        // The first attempt stopped the shared poll timer in its error path;
        // restart it for the retry so streamed text keeps updating.
        if (withoutTemperature && state.timer)
            state.timer.start();
    }

    var handle = {
        xhr: null,
        setPollTimer: function(timer) {
            state.timer = timer;
            if (state.attempt && typeof state.attempt.setPollTimer === "function")
                state.attempt.setPollTimer(timer);
        },
        processBuffer: function() {
            if (state.attempt && typeof state.attempt.processBuffer === "function")
                state.attempt.processBuffer();
        },
        abort: function() {
            state.cancelled = true;
            if (!state.attempt) return;
            if (state.attempt.xhr) state.attempt.xhr.abort();
            else if (typeof state.attempt.abort === "function") state.attempt.abort();
        }
    };

    start(false);
    return handle;
}
