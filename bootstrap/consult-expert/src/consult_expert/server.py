"""Stdio MCP tools; all Codex work belongs to the detached job supervisor."""
import asyncio
import json
import logging
import sys
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent, CallToolResult
from . import __version__
from .contracts import TOOLS, DESCRIPTION, tool_input_schema
from .runner import validate, workspace_path, QUOTA_CODE, unavailable_result
from .settings import Settings, ExpertError, status, require_chatgpt
from .client import call

server = Server('consult-expert', version=__version__)
DESCRIPTIONS = {
    'consult_expert': DESCRIPTION,
    'expert_status': 'For user-requested expert work. No arguments: check readiness and permission modes without spending allowance. With an already authorized job_id: wait for progress, a human question, or completion. Poll sequentially with wait_seconds=60 and the latest after_revision. In full mode keep the repository paused until a terminal state. Default-mode sandbox_path contains files for later Cline handover. A wait timeout is still running.',
    'expert_reply': 'Resume the job with the actual human answer to its current request_id. Present the returned question/options and wait; never invent an answer.',
    'expert_cancel': 'Cancel when the user cancels or changes the assignment. Waits for the worker to stop; saved edits remain.',
}



@server.list_tools()
async def list_tools():
    return [Tool(name=name, description=DESCRIPTIONS[name], inputSchema=tool_input_schema(schema),
                 annotations={'readOnlyHint': name == 'expert_status', 'destructiveHint': False,
                              'openWorldHint': name in ('consult_expert', 'expert_reply'), 'idempotentHint': True})
            for name, schema in TOOLS.items()]


@server.call_tool()
async def call_tool(name, arguments):
    try:
        arguments = arguments or {}
        validate(name, arguments)
        settings = Settings.load()
        if name == 'expert_status' and not arguments.get('job_id'):
            result = status(settings)
        else:
            if name == 'consult_expert':
                require_chatgpt(settings)
                workspace_path(arguments['workspace_path'], settings)
            result = await call(settings, name, arguments)
        return CallToolResult(content=[TextContent(type='text', text=json.dumps(result, ensure_ascii=False))])
    except ExpertError as exc:
        if exc.code == QUOTA_CODE:
            return CallToolResult(content=[TextContent(type='text', text=json.dumps(unavailable_result()))], isError=False)
        result = {'status': 'error', 'code': exc.code, 'message': str(exc), 'retryable': False}
    except Exception:
        result = {'status': 'error', 'code': 'INTERNAL_ERROR', 'message': 'Expert operation failed; saved edits remain. No credentials or raw process output were returned.', 'retryable': False}
    return CallToolResult(content=[TextContent(type='text', text=json.dumps(result))], isError=True)


async def run():
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())


def main():
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    asyncio.run(run())


if __name__ == '__main__':
    main()
