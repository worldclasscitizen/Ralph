from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


@dataclass
class ApiError(RuntimeError):
    error_class: str
    message: str
    http_status: int | None = None

    def __str__(self) -> str:
        return self.message


def _classify_http(status: int) -> str:
    if status == 429:
        return "rate_limit"
    if status in {500, 502, 503, 504}:
        return "server_error"
    if status in {401, 403}:
        return "authentication"
    if status == 400:
        return "invalid_request"
    return "unknown"


class ChatCompletionsProvider:
    def __init__(
        self,
        *,
        provider: str,
        base_url: str,
        api_key: str,
        model_id: str,
        reasoning_effort: str,
        timeout_seconds: int,
    ) -> None:
        self.provider = provider
        self.endpoint = f"{base_url.rstrip('/')}/chat/completions"
        self.api_key = api_key
        self.model_id = model_id
        self.reasoning_effort = reasoning_effort
        self.timeout_seconds = timeout_seconds

    def complete(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.model_id,
            "messages": messages,
            "thinking": {"type": "enabled"},
            "reasoning_effort": self.reasoning_effort,
            "stream": False,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        request = urllib.request.Request(
            self.endpoint,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            try:
                body = exc.read().decode("utf-8", errors="replace")
            except OSError:
                body = ""
            try:
                parsed = json.loads(body)
                message = parsed.get("error", {}).get("message") or parsed.get("message") or body
            except json.JSONDecodeError:
                message = body or f"HTTP {exc.code}"
            raise ApiError(_classify_http(exc.code), str(message)[:800], exc.code) from exc
        except (TimeoutError, socket.timeout) as exc:
            raise ApiError("timeout", "API request timeout") from exc
        except urllib.error.URLError as exc:
            reason = str(exc.reason)
            error_class = "timeout" if "timed out" in reason.lower() else "server_error"
            raise ApiError(error_class, f"API transport error: {reason}") from exc

        try:
            data = json.loads(raw)
            message = data["choices"][0]["message"]
        except (json.JSONDecodeError, KeyError, IndexError, TypeError) as exc:
            raise ApiError("invalid_request", "API 응답에 choices[0].message가 없습니다.") from exc
        if not isinstance(message, dict):
            raise ApiError("invalid_request", "API assistant message가 객체가 아닙니다.")
        message.setdefault("role", "assistant")
        return {"message": message, "usage": data.get("usage", {}), "request_id": data.get("id")}
