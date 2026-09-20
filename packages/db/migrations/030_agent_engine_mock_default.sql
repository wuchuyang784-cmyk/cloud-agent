-- agent.engine 语义收口：值域扩展为 mock|pi|dsh，默认 mock。
-- 背景：022 曾以 'dsh' 作默认且仅允许 pi/dsh，但 createAgent 未显式写 engine，
-- 导致历史行 engine='dsh' 实际走 mock 运行时，语义与事实不符。
-- 本迁移把 engine 当作“Agent 声明/选择的运行时引擎”（mock 表示未接真实引擎），
-- 历史 mock 运行时行回填为 mock；后续创建以显式 engine 落库。

ALTER TABLE agents
  DROP CONSTRAINT IF EXISTS agents_engine_check;

ALTER TABLE agents
  ADD CONSTRAINT agents_engine_check CHECK (engine IN ('mock', 'pi', 'dsh'));

ALTER TABLE agents
  ALTER COLUMN engine SET DEFAULT 'mock';

UPDATE agents
   SET engine = 'mock'
 WHERE engine = 'dsh'
   AND runtime_kind = 'mock';
