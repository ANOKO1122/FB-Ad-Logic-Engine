"""
权限隔离与单条规则执行 API 测试（pytest）

测试目标（4.1.3）：
1. 数据接口 IDOR：非 admin 用他人 account_id 访问 /api/ads 等应 403
2. 健康接口：非 admin 只看到自己 owner_id 下的账户
3. execute-all：非 admin 可触发，后端只跑自己负责人下的账户（接口 200）
4. 单条规则执行：权限与返回格式

运行前：确保后端已启动（如 npm run dev），且库中有 admin、staff 用户及 account_mappings。

运行方法：
    pytest test_permission_isolation_api.py -v
    pytest test_permission_isolation_api.py -v -s          # 带 print
    pytest test_permission_isolation_api.py::TestDataApiIDOR -v
"""

import pytest
import requests
from typing import Optional, List, Dict

BASE_URL = "http://localhost:3000"


# ==================== Fixtures ====================

@pytest.fixture(scope="module")
def admin_token() -> Optional[str]:
    """admin 的 token"""
    url = f"{BASE_URL}/api/auth/login"
    payload = {"username": "admin", "password": "admin123"}
    try:
        r = requests.post(url, json=payload, timeout=5)
        r.raise_for_status()
        data = r.json()
        if data.get("success") and data.get("token"):
            return data["token"]
        pytest.skip(f"登录失败: {data.get('error', '未知')}")
    except Exception as e:
        pytest.skip(f"登录异常: {e}")


@pytest.fixture(scope="module")
def staff_token() -> Optional[str]:
    """staff（普通用户）的 token，需有 owner_id 且非 admin"""
    url = f"{BASE_URL}/api/auth/login"
    payload = {"username": "test2", "password": "123456"}
    try:
        r = requests.post(url, json=payload, timeout=5)
        r.raise_for_status()
        data = r.json()
        if data.get("success") and data.get("token"):
            user = data.get("user", {})
            if user.get("role") == "admin":
                pytest.skip("test2 是 admin，请换一个 staff 账号")
            return data["token"]
        pytest.skip(f"登录失败: {data.get('error', '未知')}")
    except Exception as e:
        pytest.skip(f"登录异常: {e}")


def _get_health(token: str) -> Dict:
    """GET /api/system/health，返回 JSON"""
    r = requests.get(
        f"{BASE_URL}/api/system/health",
        headers={"Authorization": f"Bearer {token}"},
        timeout=5,
    )
    r.raise_for_status()
    return r.json()


def _account_ids_from_health(data: Dict) -> List[str]:
    """从 health 返回里取出 account_id 列表"""
    accounts = data.get("accounts") or []
    return [a.get("account_id") for a in accounts if a.get("account_id")]


@pytest.fixture(scope="module")
def staff_sees_fewer_accounts_than_admin(admin_token: str, staff_token: str) -> Optional[str]:
    """
    若 admin 看到的账户比 staff 多，返回一个「属于 admin 但不属于 staff」的 account_id。
    若无法构造则返回 None（测试里可用 forbidden_account_id_for_staff 兜底）。
    """
    admin_health = _get_health(admin_token)
    staff_health = _get_health(staff_token)
    admin_ids = set(_account_ids_from_health(admin_health))
    staff_ids = set(_account_ids_from_health(staff_health))
    forbidden = admin_ids - staff_ids
    if forbidden:
        return next(iter(forbidden))
    return None


@pytest.fixture(scope="module")
def forbidden_account_id_for_staff(staff_sees_fewer_accounts_than_admin) -> str:
    """
    返回一个「staff 无权访问」的 account_id：优先用「他人账户」，否则用假 ID（也会 403）。
    """
    if staff_sees_fewer_accounts_than_admin:
        return staff_sees_fewer_accounts_than_admin
    return "act_999999999"


# ==================== 1. 数据接口 IDOR ====================

@pytest.mark.api
class TestDataApiIDOR:
    """带 account_id 的数据接口必须做账户权限校验，非 admin 访问他人账户应 403"""

    def test_ads_forbidden_account_returns_403(self, staff_token: str, forbidden_account_id_for_staff: str):
        """非 admin 用他人/无效 account_id 调 /api/ads 应 403"""
        account_id = forbidden_account_id_for_staff
        url = f"{BASE_URL}/api/ads"
        r = requests.get(
            url,
            params={"account_id": account_id},
            headers={"Authorization": f"Bearer {staff_token}"},
            timeout=5,
        )
        assert r.status_code == 403, f"应 403，实际: {r.status_code}"
        data = r.json() if r.text else {}
        assert data.get("code") == "ACCOUNT_FORBIDDEN" or "无权" in (data.get("error") or "")

    def test_insights_forbidden_account_returns_403(self, staff_token: str, forbidden_account_id_for_staff: str):
        """非 admin 用他人/无效 account_id 调 /api/insights 应 403"""
        account_id = forbidden_account_id_for_staff
        url = f"{BASE_URL}/api/insights"
        r = requests.get(
            url,
            params={"account_id": account_id, "preset": "today"},
            headers={"Authorization": f"Bearer {staff_token}"},
            timeout=5,
        )
        assert r.status_code == 403
        data = r.json() if r.text else {}
        assert data.get("code") == "ACCOUNT_FORBIDDEN" or "无权" in (data.get("error") or "")

    def test_rule_data_forbidden_account_returns_403(self, staff_token: str, forbidden_account_id_for_staff: str):
        """非 admin 用他人/无效 account_id 调 /api/rule-data 应 403"""
        account_id = forbidden_account_id_for_staff
        url = f"{BASE_URL}/api/rule-data"
        r = requests.get(
            url,
            params={"account_id": account_id, "time_window": "today"},
            headers={"Authorization": f"Bearer {staff_token}"},
            timeout=5,
        )
        assert r.status_code == 403
        data = r.json() if r.text else {}
        assert data.get("code") == "ACCOUNT_FORBIDDEN" or "无权" in (data.get("error") or "")

    def test_structure_level_forbidden_account_returns_403(self, staff_token: str, forbidden_account_id_for_staff: str):
        """非 admin 用他人/无效 account_id 调 /api/structure/ads 应 403"""
        account_id = forbidden_account_id_for_staff
        url = f"{BASE_URL}/api/structure/ads"
        r = requests.get(
            url,
            params={"account_id": account_id, "limit": 10},
            headers={"Authorization": f"Bearer {staff_token}"},
            timeout=5,
        )
        assert r.status_code == 403
        data = r.json() if r.text else {}
        assert data.get("code") == "ACCOUNT_FORBIDDEN" or "无权" in (data.get("error") or "")

    def test_staff_can_access_own_account_ads(self, staff_token: str):
        """非 admin 用自己负责的 account_id 调 /api/ads 应 200"""
        staff_health = _get_health(staff_token)
        own_ids = _account_ids_from_health(staff_health)
        if not own_ids:
            pytest.skip("staff 下没有账户，无法测「访问自己账户」")
        url = f"{BASE_URL}/api/ads"
        r = requests.get(
            url,
            params={"account_id": own_ids[0]},
            headers={"Authorization": f"Bearer {staff_token}"},
            timeout=5,
        )
        assert r.status_code == 200, f"访问自己账户应 200，实际: {r.status_code}"


# ==================== 2. 健康接口按角色裁剪 ====================

@pytest.mark.api
class TestHealthByRole:
    """GET /api/system/health：admin 看全部，非 admin 只看自己 owner 的账户"""

    def test_staff_health_accounts_subset_of_admin(self, admin_token: str, staff_token: str):
        """非 admin 返回的 accounts 应是 admin 返回的子集（且数量不超过 admin）"""
        admin_health = _get_health(admin_token)
        staff_health = _get_health(staff_token)
        admin_ids = set(_account_ids_from_health(admin_health))
        staff_ids = set(_account_ids_from_health(staff_health))
        assert staff_ids <= admin_ids, "staff 的账户集合应是 admin 的子集"
        assert len(staff_ids) <= len(admin_ids)

    def test_health_returns_success_and_accounts(self, staff_token: str):
        """健康接口返回 success 和 accounts 数组"""
        data = _get_health(staff_token)
        assert data.get("success") is True
        assert "accounts" in data
        assert isinstance(data["accounts"], list)


# ==================== 3. execute-all 方案B ====================

@pytest.mark.api
class TestExecuteAllByRole:
    """POST /api/rules/execute-all：非 admin 可调用，后端只跑自己负责人下的账户"""

    def test_staff_can_trigger_execute_all_returns_200(self, staff_token: str):
        """非 admin 调用 execute-all 应 200，且返回 success"""
        url = f"{BASE_URL}/api/rules/execute-all"
        r = requests.post(
            url,
            headers={"Authorization": f"Bearer {staff_token}", "Content-Type": "application/json"},
            timeout=10,
        )
        assert r.status_code == 200, f"应 200，实际: {r.status_code}"
        data = r.json() if r.text else {}
        assert data.get("success") is True
        assert "message" in data


# ==================== 4. 单条规则执行 ====================

@pytest.mark.api
class TestSingleRuleExecute:
    """POST /api/rules/:id/execute：权限与返回格式"""

    def test_execute_nonexistent_rule_returns_404(self, staff_token: str):
        """执行不存在的规则 ID 应 404"""
        url = f"{BASE_URL}/api/rules/99999999/execute"
        r = requests.post(
            url,
            headers={"Authorization": f"Bearer {staff_token}", "Content-Type": "application/json"},
            timeout=5,
        )
        assert r.status_code == 404, f"应 404，实际: {r.status_code}"
        if r.text and r.text.strip():
            try:
                data = r.json()
                assert "不存在" in (data.get("error") or "") or data.get("code") == "NOT_FOUND"
            except Exception:
                pass  # 404 时 body 可能非 JSON，只断言状态码即可

    def test_execute_own_rule_returns_200_or_409(self, staff_token: str):
        """staff 执行自己的一条规则应 200（或 409 账户锁占用）"""
        r = requests.get(
            f"{BASE_URL}/api/rules",
            headers={"Authorization": f"Bearer {staff_token}"},
            timeout=5,
        )
        assert r.status_code == 200
        data = r.json()
        rules = data.get("rules") or []
        if not rules:
            pytest.skip("当前 staff 没有规则，无法测单条执行")
        first = rules[0]
        rule_id = first.get("id") or first.get("ruleId") or first.get("rule_id")
        if rule_id is None:
            pytest.skip("规则列表缺少 id 字段，无法测单条执行")
        url = f"{BASE_URL}/api/rules/{rule_id}/execute"
        r2 = requests.post(
            url,
            headers={"Authorization": f"Bearer {staff_token}", "Content-Type": "application/json"},
            timeout=15,
        )
        assert r2.status_code in [200, 409], f"应 200 或 409，实际: {r2.status_code}"
        if r2.status_code == 200:
            body = r2.json()
            assert body.get("success") is True
            assert "rule_id" in body and "account_id" in body
            assert "matched_count" in body and "executed_count" in body and "failed_count" in body
            assert "status" in body and "run_id" in body


# ==================== 运行说明 ====================
"""
前置：后端已启动（如 npm run dev），且库中有 admin、staff 用户及 account_mappings。
      staff 建议用 test2（密码 123456），且 test2 的 owner_id 下至少有一个账户。

安装依赖：
    pip install -r requirements-test.txt

运行所有权限隔离测试：
    pytest test_permission_isolation_api.py -v

带 print 输出：
    pytest test_permission_isolation_api.py -v -s

只跑某一大类：
    pytest test_permission_isolation_api.py::TestDataApiIDOR -v
    pytest test_permission_isolation_api.py::TestHealthByRole -v
    pytest test_permission_isolation_api.py::TestExecuteAllByRole -v
    pytest test_permission_isolation_api.py::TestSingleRuleExecute -v
"""
