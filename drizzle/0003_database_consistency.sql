-- 0001 和 0002 已创建任务/资产表及全部 CHECK、索引；旧 snapshot 遗漏了它们。
-- 不重建已有对象，仅补齐 schema 已声明但历史 SQL 未创建的版本表。
CREATE TABLE "__painttrack_schema_version" (
    "version" integer PRIMARY KEY NOT NULL
);
