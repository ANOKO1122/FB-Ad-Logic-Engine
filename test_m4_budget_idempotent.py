"""
M4 3.2 预算幂等 — 验证 3：用 pytest 跑 Node 单测

验证 3 的断言写在 Node 里（Vitest）：传 _resolvedBudgetCents 时不再调用 getAdsetBudget。
pytest 这里只负责「调 Vitest 跑该用例」并检查退出码，方便你统一用 pytest 跑全部验证。

运行方法（在项目根目录）：
    pytest test_m4_budget_idempotent.py -v
    pytest test_m4_budget_idempotent.py -v -s
"""

import subprocess
import sys


def test_m4_budget_idempotent_verification3():
    """验证 3：传 _resolvedBudgetCents 时不再 GET、只 POST 该值（由 Vitest 断言）"""
    result = subprocess.run(
        ["npm", "test", "--", "--run", "server/tests/actionExecutorBudgetIdempotent.test.js"],
        cwd=".",
        capture_output=True,
        text=True,
        timeout=30,
        shell=(sys.platform == "win32"),
    )
    assert result.returncode == 0, (
        f"Vitest 验证 3 未通过 (exit {result.returncode}).\n"
        f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )
