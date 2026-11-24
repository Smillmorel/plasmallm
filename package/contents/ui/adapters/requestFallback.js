/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

// Request fallbacks for provider-side quirks that are cheaper to absorb than
// to model in a capability table. Both rules retry at most once per request,
// only when the failed attempt produced no output, and only for errors that
// arrive before any streamed content.
//
//   1. Unsupported temperature. Newer models reject the field outright
//      (OpenAI GPT-5/6 reasoning models: "Unsupported parameter:
//      'temperature' is not supported with this model"; Anthropic Claude
//      Haiku 5.x: "temperature is deprecated for this model"). Retry without
//      it and remember the endpoint/model for the session.
//
//   2. Truncated tool call. llama.cpp/llama-swap answers HTTP 500 with
//      "Failed to parse tool call arguments as JSON ... missing closing
//      quote" when the model's tool-call arguments are cut off at the output
//      limit. Retry once with a larger token budget; if it still fails, add
//      actionable guidance to the error shown to the user.
//
// The returned handle matches the adapter handle surface main.qml relies on:
// `.xhr` (for abort), `setPollTimer(timer)` and `processBuffer()`.

.import "../utils.js" as Utils

var temperatureRejected = {};

function tr(text) {
    return (typeof i18n === "function") ? i18n(text) : text;
}

function cacheKey(opts) {
    return String(opts.endpoint || "") + "|" + String(opts.model || "");
}

function copyOpts(opts) {
    var o = {};
    for (var k in opts) {
        if (opts.hasOwnProperty(k))
            o[k] = opts[k];
    }
    return o;
}

// Cut llama-swap's multi-kilobyte dump of the malformed arguments at the
// human-readable "last read:" marker so the chat bubble stays useful.
function compactToolCallError(error) {
    var s = String(error || "");
    var marker = s.toLowerCase().indexOf("last read:");
    if (marker > 0)
        s = s.substring(0, marker) + "(tool-call arguments truncated)";
    return tr("The model's tool call was cut off before it finished (output limit reached). " +
              "Raise Max Tokens or ask for a smaller edit, then try again.") + "\n\n" + s;
}

function send(adapter, opts) {
    var hasTemperature = opts && typeof opts.temperature === "number";
    var hasMaxTokens = opts && typeof opts.maxTokens === "number";
    if (!opts || (!hasTemperature && !hasMaxTokens))
        return adapter.sendStreaming(opts);

    var key = cacheKey(opts);
    var state = {
        attempt: null,
        timer: null,
        cancelled: false,
        streamed: false
    };
    var onChunk = opts.onChunk;
    var onThinkingChunk = opts.onThinkingChunk;
    var onComplete = opts.onComplete;

    function buildOpts(attempt) {
        var o = copyOpts(opts);
        delete o.temperature;
        if (!attempt.skipTemperature && hasTemperature)
            o.temperature = opts.temperature;
        o.skipTemperature = attempt.skipTemperature;
        if (typeof attempt.maxTokens === "number")
            o.maxTokens = attempt.maxTokens;
        o.onChunk = function(delta, accumulated) {
            state.streamed = true;
            if (onChunk) onChunk(delta, accumulated);
        };
        o.onThinkingChunk = function(delta, accumulated) {
            state.streamed = true;
            if (onThinkingChunk) onThinkingChunk(delta, accumulated);
        };
        o.onComplete = function(text, error, toolCalls, message) {
            if (error && !state.cancelled && !state.streamed) {
                if (!attempt.skipTemperature && hasTemperature
                        && Utils.isUnsupportedTemperatureError(error)) {
                    temperatureRejected[key] = true;
                    console.warn("PlasmaLLM: model '" + (opts.model || "?") +
                                 "' rejected the temperature parameter; retrying without it");
                    start({ skipTemperature: true, maxTokens: attempt.maxTokens,
                            budgetRetried: attempt.budgetRetried });
                    return;
                }
                if (!attempt.budgetRetried && typeof attempt.maxTokens === "number"
                        && Utils.isToolCallArgumentParseError(error)) {
                    var bigger = Math.min(Math.max(attempt.maxTokens * 4, 8192), 16384);
                    if (bigger > attempt.maxTokens) {
                        console.warn("PlasmaLLM: model '" + (opts.model || "?") +
                                     "' produced a truncated tool call; retrying with maxTokens " + bigger);
                        start({ skipTemperature: attempt.skipTemperature, maxTokens: bigger,
                                budgetRetried: true });
                        return;
                    }
                }
                if (Utils.isToolCallArgumentParseError(error))
                    error = compactToolCallError(error);
            }
            if (onComplete) onComplete(text, error, toolCalls, message);
        };
        return o;
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

    function start(attempt) {
        state.attempt = adapter.sendStreaming(buildOpts(attempt));
        handle.xhr = state.attempt ? state.attempt.xhr : null;
        if (state.timer && state.attempt && typeof state.attempt.setPollTimer === "function")
            state.attempt.setPollTimer(state.timer);
        // The failed attempt stops the shared poll timer in its error path;
        // restart it for the retry so streamed text keeps updating.
        if ((attempt.skipTemperature || attempt.budgetRetried) && state.timer)
            state.timer.start();
    }

    start({
        skipTemperature: hasTemperature && !!temperatureRejected[key],
        maxTokens: opts.maxTokens,
        budgetRetried: false
    });
    return handle;
}
