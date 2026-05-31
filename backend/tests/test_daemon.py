import json
import pytest
import asyncio
from unittest.mock import patch, AsyncMock

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))


@pytest.fixture
def daemon_module():
    import daemon
    daemon.state = daemon.DaemonState()
    return daemon


class TestDaemonState:
    def test_initial_state(self, daemon_module):
        s = daemon_module.DaemonState()
        assert s.total_prompts_executed == 0
        assert len(s.connected_clients) == 0
        assert len(s.prompt_history) == 0

    def test_uptime_seconds(self, daemon_module):
        s = daemon_module.DaemonState()
        assert s.uptime_seconds >= 0

    def test_record_prompt(self, daemon_module):
        s = daemon_module.DaemonState()
        s.record_prompt("test prompt", {"status": "SUCCESS"})
        assert s.total_prompts_executed == 1
        assert len(s.prompt_history) == 1
        assert s.prompt_history[0]["prompt"] == "test prompt"
        assert s.prompt_history[0]["result"] == "SUCCESS"

    def test_prompt_history_cap(self, daemon_module):
        s = daemon_module.DaemonState()
        for i in range(60):
            s.record_prompt(f"prompt {i}", {"status": "SUCCESS"})
        assert len(s.prompt_history) == 50
        assert s.total_prompts_executed == 60


class TestVSCodeCheck:
    def test_vscode_cli_check(self, daemon_module):
        result = daemon_module.check_vscode_cli()
        assert isinstance(result, bool)


class TestExecuteVSCode:
    @pytest.mark.asyncio
    async def test_vscode_unavailable(self, daemon_module):
        daemon_module.state.vscode_available = False
        result = await daemon_module.execute_vscode_command("test")
        assert result["status"] == "ERROR"
        assert "not found" in result["message"]

    @pytest.mark.asyncio
    async def test_vscode_success(self, daemon_module):
        daemon_module.state.vscode_available = True

        mock_process = AsyncMock()
        mock_process.communicate = AsyncMock(return_value=(b"ok", b""))
        mock_process.returncode = 0

        with patch("asyncio.create_subprocess_exec", return_value=mock_process):
            result = await daemon_module.execute_vscode_command("hello world")
        assert result["status"] == "SUCCESS"
        assert result["exit_code"] == 0

    @pytest.mark.asyncio
    async def test_vscode_timeout(self, daemon_module):
        daemon_module.state.vscode_available = True

        mock_process = AsyncMock()
        mock_process.communicate = AsyncMock(side_effect=asyncio.TimeoutError)

        with patch("asyncio.create_subprocess_exec", return_value=mock_process):
            with patch("asyncio.wait_for", side_effect=asyncio.TimeoutError):
                result = await daemon_module.execute_vscode_command("slow prompt")
        assert result["status"] == "ERROR"
        assert "timed out" in result["message"].lower() or result["exit_code"] == -1
