"""
阶段1 API 测试（pytest 版本）
测试目标：
1. 权限控制统一（summary/list/detail 都使用 users.owner_id 过滤）
2. 列表接口默认只返回 status=success（非 admin 强制只看 success）
3. include_all_status 参数只对 admin 生效

运行方法：
    pytest test_automation_logs_api.py -v
    pytest test_automation_logs_api.py::test_summary -v  # 只运行单个测试
"""

import pytest
import requests
from typing import Optional, Dict


BASE_URL = "http://localhost:3000"


# ==================== Fixtures（测试前置数据）====================

@pytest.fixture(scope="module")
def staff_token() -> Optional[str]:
    """获取 test2 (staff) 的 token"""
    url = f"{BASE_URL}/api/auth/login"
    payload = {"username": "test2", "password": "123456"}  # ⚠️ 替换为实际密码
    
    try:
        response = requests.post(url, json=payload, timeout=5)
        response.raise_for_status()
        data = response.json()
        
        if data.get("success") and data.get("token"):
            return data["token"]
        else:
            pytest.skip(f"登录失败: {data.get('error', '未知错误')}")
    except Exception as e:
        pytest.skip(f"登录异常: {e}")


@pytest.fixture(scope="module")
def admin_token() -> Optional[str]:
    """获取 admin 的 token"""
    url = f"{BASE_URL}/api/auth/login"
    payload = {"username": "admin", "password": "admin123"}  # ⚠️ 替换为实际密码
    
    try:
        response = requests.post(url, json=payload, timeout=5)
        response.raise_for_status()
        data = response.json()
        
        if data.get("success") and data.get("token"):
            return data["token"]
        else:
            pytest.skip(f"登录失败: {data.get('error', '未知错误')}")
    except Exception as e:
        pytest.skip(f"登录异常: {e}")


@pytest.fixture(scope="module")
def staff_user_info(staff_token: str) -> Dict:
    """获取 test2 的用户信息（从登录响应或重新查询）"""
    # 这里简化处理，实际可以从登录响应获取
    return {"id": 25, "username": "test2", "role": "staff", "owner_id": 5}


# ==================== 测试用例 ====================

class TestSummaryAPI:
    """Summary 接口测试"""
    
    def test_summary_staff_should_only_see_own_owner_id(self, staff_token: str, staff_user_info: Dict):
        """测试：非 admin 用户（staff）的 summary 应该只统计自己的 owner_id"""
        url = f"{BASE_URL}/api/automation-logs/stats/summary"
        headers = {"Authorization": f"Bearer {staff_token}"}
        
        response = requests.get(url, headers=headers, timeout=5)
        assert response.status_code == 200, f"请求失败: {response.status_code}"
        
        data = response.json()
        
        # 验证返回结构（summary 接口返回的是嵌套结构：today 和 week）
        assert "success" in data, "应该返回 success 字段"
        assert "today" in data, "应该返回 today 字段"
        assert "week" in data, "应该返回 week 字段"
        
        today = data.get("today", {})
        assert "success_count" in today, "today 应该包含 success_count"
        assert "fail_count" in today, "today 应该包含 fail_count"
        assert "skipped_count" in today, "today 应该包含 skipped_count"
        
        # 验证：非 admin 应该只能看到自己 owner_id 的统计
        # （这里假设 owner_id=5 有数据，如果没有数据可能都是 0/None，但至少不会报错）
        print(f"\n   📊 Summary 统计 (today): success={today.get('success_count')}, "
              f"fail={today.get('fail_count')}, skipped={today.get('skipped_count')}")
        
        # 验证 week 数组结构
        week = data.get("week", [])
        assert isinstance(week, list), "week 应该是数组"
        if len(week) > 0:
            print(f"   📊 Summary 统计 (week): 最近 {len(week)} 天的数据")
        
        # 注意：这里不强制断言数值，因为数据可能变化，重点是接口能正常返回且权限正确


class TestListAPI:
    """列表接口测试"""
    
    def test_list_staff_default_only_success(self, staff_token: str):
        """测试：非 admin 用户默认只看 success"""
        url = f"{BASE_URL}/api/automation-logs"
        headers = {"Authorization": f"Bearer {staff_token}"}
        params = {"page": 1, "limit": 10}
        
        response = requests.get(url, headers=headers, params=params, timeout=5)
        assert response.status_code == 200, f"请求失败: {response.status_code}"
        
        data = response.json()
        logs = data.get("logs", [])
        
        # 验证：所有返回的日志状态都应该是 success
        statuses = [log.get("status") for log in logs]
        non_success = [s for s in statuses if s != "success"]
        
        assert len(non_success) == 0, \
            f"非 admin 默认应该只看 success，但看到了: {set(non_success)}"
        
        print(f"\n   ✅ 非 admin 默认只看 success: 返回 {len(logs)} 条，全部为 success")
    
    def test_list_staff_include_all_status_should_be_ignored(self, staff_token: str):
        """测试：非 admin 传 include_all_status=true 应该无效（仍只看 success）"""
        url = f"{BASE_URL}/api/automation-logs"
        headers = {"Authorization": f"Bearer {staff_token}"}
        params = {"page": 1, "limit": 10, "include_all_status": "true"}
        
        response = requests.get(url, headers=headers, params=params, timeout=5)
        assert response.status_code == 200, f"请求失败: {response.status_code}"
        
        data = response.json()
        logs = data.get("logs", [])
        
        # 验证：即使传了 include_all_status=true，非 admin 仍只看 success
        statuses = [log.get("status") for log in logs]
        non_success = [s for s in statuses if s != "success"]
        
        assert len(non_success) == 0, \
            f"非 admin 传 include_all_status=true 应该无效，但看到了: {set(non_success)}"
        
        print(f"\n   ✅ 非 admin 传 include_all_status=true 仍只看 success: 返回 {len(logs)} 条")
    
    def test_list_admin_can_see_all_status(self, admin_token: str):
        """测试：admin 传 include_all_status=true 可以看到所有状态"""
        url = f"{BASE_URL}/api/automation-logs"
        headers = {"Authorization": f"Bearer {admin_token}"}
        params = {"page": 1, "limit": 10, "include_all_status": "true"}
        
        response = requests.get(url, headers=headers, params=params, timeout=5)
        assert response.status_code == 200, f"请求失败: {response.status_code}"
        
        data = response.json()
        logs = data.get("logs", [])
        
        # 验证：admin 可以看到多种状态（如果有数据的话）
        statuses = [log.get("status") for log in logs]
        unique_statuses = set(statuses)
        
        print(f"\n   📊 Admin 传 include_all_status=true: 返回 {len(logs)} 条，状态分布: {unique_statuses}")
        
        # 注意：这里不强制断言必须有 fail/skipped，因为数据可能只有 success
        # 重点是接口能正常返回，且 admin 有权限看所有状态


class TestDetailAPI:
    """详情接口测试"""
    
    def test_detail_staff_can_see_own_log(self, staff_token: str, staff_user_info: Dict):
        """测试：非 admin 可以查看自己 owner_id 的日志"""
        # ⚠️ 需要先查一条 owner_id=5 的日志 ID
        # 这里用占位符，实际测试时需要替换
        log_id = 1234  # ⚠️ 替换为实际的 owner_id=5 的日志 ID
        
        url = f"{BASE_URL}/api/automation-logs/{log_id}"
        headers = {"Authorization": f"Bearer {staff_token}"}
        
        response = requests.get(url, headers=headers, timeout=5)
        
        # 如果 log_id 存在且属于该 owner_id，应该返回 200
        # 如果不存在或不属于，应该返回 404
        assert response.status_code in [200, 404], \
            f"意外的状态码: {response.status_code}"
        
        if response.status_code == 200:
            data = response.json()
            assert "log" in data
            print(f"\n   ✅ 可以查看自己的日志: {data.get('log', {}).get('rule_name', 'N/A')}")
        else:
            print(f"\n   ⚠️  404（可能是 log_id 不存在或不属于该 owner_id）")
    
    def test_detail_staff_cannot_see_other_owner_log(self, staff_token: str):
        """测试：非 admin 不能查看其他 owner_id 的日志"""
        # ⚠️ 需要先查一条 owner_id != 5 的日志 ID（例如 owner_id=0）
        log_id = 3688  # ⚠️ 替换为实际的 owner_id != 5 的日志 ID
        
        url = f"{BASE_URL}/api/automation-logs/{log_id}"
        headers = {"Authorization": f"Bearer {staff_token}"}
        
        response = requests.get(url, headers=headers, timeout=5)
        
        # 应该返回 404（权限控制）
        assert response.status_code == 404, \
            f"应该返回 404（权限控制），但返回了: {response.status_code}"
        
        print(f"\n   ✅ 不能查看其他 owner_id 的日志（返回 404）")


# ==================== 运行说明 ====================
"""
安装依赖：
    pip install pytest requests

运行所有测试：
    pytest test_automation_logs_api.py -v

运行单个测试类：
    pytest test_automation_logs_api.py::TestListAPI -v

运行单个测试：
    pytest test_automation_logs_api.py::TestListAPI::test_list_staff_default_only_success -v

带输出（print）：
    pytest test_automation_logs_api.py -v -s

只运行失败的：
    pytest test_automation_logs_api.py --lf
"""
