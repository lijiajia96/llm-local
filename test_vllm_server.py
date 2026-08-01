#!/usr/bin/env python3
"""Smoke-test an OpenAI-compatible vLLM server.

The script intentionally uses only the Python standard library so it can run on
machines without the openai or requests packages installed.
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_BASE_URL = os.environ.get("VLLM_BASE_URL", "http://127.0.0.1:8000/v1")
DEFAULT_TEXT_PROMPT = "Reply with exactly: vLLM text OK"
DEFAULT_VISION_PROMPT = "Describe this image in one short sentence."

# 1x1 transparent PNG. Kept inline so the vision smoke test has no file
# dependency by default.
DEFAULT_IMAGE_DATA_URL = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAF"
    "gwJ/l7ZobwAAAABJRU5ErkJggg=="
)


class VllmTestError(RuntimeError):
    """Raised when a vLLM smoke-test step fails."""


def normalize_base_url(base_url: str) -> str:
    return base_url.rstrip("/")


def request_json(
    method: str,
    url: str,
    timeout: float,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw_body = response.read()
            text_body = raw_body.decode("utf-8", errors="replace")
            if not text_body:
                return {}
            return json.loads(text_body)
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise VllmTestError(f"{method} {url} returned HTTP {exc.code}: {error_body}") from exc
    except urllib.error.URLError as exc:
        raise VllmTestError(f"{method} {url} failed: {exc.reason}") from exc
    except TimeoutError as exc:
        raise VllmTestError(f"{method} {url} timed out after {timeout:g}s") from exc
    except json.JSONDecodeError as exc:
        raise VllmTestError(f"{method} {url} returned non-JSON response") from exc


def load_image_data_url(image_path: str | None, image_url: str | None) -> str:
    if image_path and image_url:
        raise VllmTestError("Use only one of --image-path or --image-url.")
    if image_url:
        return image_url
    if not image_path:
        return DEFAULT_IMAGE_DATA_URL

    path = Path(image_path).expanduser()
    if not path.is_file():
        raise VllmTestError(f"Image path does not exist or is not a file: {path}")

    mime_type, _ = mimetypes.guess_type(path.name)
    if mime_type is None:
        mime_type = "application/octet-stream"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def extract_model_id(models_response: dict[str, Any], requested_model: str | None) -> str:
    if requested_model:
        return requested_model

    data = models_response.get("data")
    if not isinstance(data, list) or not data:
        raise VllmTestError("Model list did not contain any models; pass --model explicitly.")

    first_model = data[0]
    if not isinstance(first_model, dict) or not isinstance(first_model.get("id"), str):
        raise VllmTestError("Model list response has no usable data[0].id; pass --model explicitly.")
    return first_model["id"]


def print_step(name: str, ok: bool, detail: str) -> None:
    status = "OK" if ok else "FAIL"
    print(f"[{status}] {name}: {detail}")


def check_models(base_url: str, timeout: float) -> dict[str, Any]:
    started_at = time.monotonic()
    response = request_json("GET", f"{base_url}/models", timeout=timeout)
    elapsed_ms = int((time.monotonic() - started_at) * 1000)

    model_ids = [
        item.get("id")
        for item in response.get("data", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    ]
    detail = f"{len(model_ids)} model(s) in {elapsed_ms} ms"
    if model_ids:
        detail += f"; first={model_ids[0]}"
    print_step("models", True, detail)
    return response


def check_chat_text(base_url: str, model: str, timeout: float, prompt: str) -> str:
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 64,
        "temperature": 0,
    }

    started_at = time.monotonic()
    response = request_json("POST", f"{base_url}/chat/completions", timeout=timeout, payload=payload)
    elapsed_ms = int((time.monotonic() - started_at) * 1000)
    content = extract_first_message_content(response)
    print_step("text chat", True, f"{elapsed_ms} ms; response={content!r}")
    return content


def check_chat_vision(
    base_url: str,
    model: str,
    timeout: float,
    prompt: str,
    image_data: str,
) -> str:
    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": image_data}},
                ],
            }
        ],
        "max_tokens": 128,
        "temperature": 0,
    }

    started_at = time.monotonic()
    response = request_json("POST", f"{base_url}/chat/completions", timeout=timeout, payload=payload)
    elapsed_ms = int((time.monotonic() - started_at) * 1000)
    content = extract_first_message_content(response)
    print_step("vision chat", True, f"{elapsed_ms} ms; response={content!r}")
    return content


def extract_first_message_content(response: dict[str, Any]) -> str:
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        raise VllmTestError("Chat response did not contain choices.")

    first_choice = choices[0]
    if not isinstance(first_choice, dict):
        raise VllmTestError("Chat response choice is not an object.")

    message = first_choice.get("message")
    if not isinstance(message, dict):
        raise VllmTestError("Chat response choice did not contain a message object.")

    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        return json.dumps(content, ensure_ascii=True)
    raise VllmTestError("Chat response message content was not a string or list.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Smoke-test an OpenAI-compatible vLLM server with text and vision chat requests.",
    )
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help=f"OpenAI-compatible API base URL. Default: {DEFAULT_BASE_URL}",
    )
    parser.add_argument(
        "--model",
        help="Model id to use. If omitted, the first id returned by /models is used.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=60.0,
        help="HTTP timeout in seconds for each request. Default: 60",
    )
    parser.add_argument(
        "--skip-vision",
        action="store_true",
        help="Skip the vision chat completion request.",
    )
    parser.add_argument(
        "--text-prompt",
        default=DEFAULT_TEXT_PROMPT,
        help=f"Prompt for the text chat test. Default: {DEFAULT_TEXT_PROMPT!r}",
    )
    parser.add_argument(
        "--vision-prompt",
        default=DEFAULT_VISION_PROMPT,
        help=f"Prompt for the vision chat test. Default: {DEFAULT_VISION_PROMPT!r}",
    )
    parser.add_argument(
        "--image-path",
        help="Local image path for the vision test. Defaults to an inline 1x1 PNG.",
    )
    parser.add_argument(
        "--image-url",
        help="HTTP(S) image URL or data URL for the vision test. Overrides the default inline image.",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    base_url = normalize_base_url(args.base_url)

    try:
        models_response = check_models(base_url, args.timeout)
        model = extract_model_id(models_response, args.model)
        print(f"Using model: {model}")
        check_chat_text(base_url, model, args.timeout, args.text_prompt)

        if args.skip_vision:
            print_step("vision chat", True, "skipped by --skip-vision")
        else:
            image_data = load_image_data_url(args.image_path, args.image_url)
            check_chat_vision(base_url, model, args.timeout, args.vision_prompt, image_data)
    except VllmTestError as exc:
        print_step("vLLM smoke test", False, str(exc))
        return 1

    print("All requested checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
