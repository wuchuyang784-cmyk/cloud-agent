-- 多组织能力预留。
--
-- 当前产品形态是"个人租户"，但数据模型从一开始就保留组织边界，避免将来升级
-- 团队协作时迁移业务数据：
--   1) organizations.kind 区分个人空间（personal）与团队组织（team），
--      个人升级为团队时只需追加成员，无需改写任何 organization_id；
--   2) 注册流程会为每个用户创建独立的个人组织，并写入 organization_members，
--      个人组织即未来团队组织的容器。
--
-- 现有行按 personal 回填：它们是注册/开发阶段创建的个人空间。

BEGIN;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'personal';

ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_kind_check;

ALTER TABLE organizations
  ADD CONSTRAINT organizations_kind_check CHECK (kind IN ('personal', 'team'));

COMMIT;
