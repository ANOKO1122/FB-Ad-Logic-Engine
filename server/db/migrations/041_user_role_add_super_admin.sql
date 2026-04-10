-- M4.1：扩展 users.role，支持 super_admin（与 plan 口径一致；存量 admin/staff 不变）
ALTER TABLE users
  MODIFY COLUMN role ENUM('super_admin', 'admin', 'staff')
  NOT NULL DEFAULT 'staff'
  COMMENT 'super_admin=超管; admin=管理员; staff=普通用户';
