-- 清理名称以 [API_TEST] 开头的演示数据。执行前先备份。
-- 仅删除明确标记的测试行，不触碰正式业务数据。

DELETE FROM erp_project WHERE name LIKE '[API_TEST]%';
DELETE FROM erp_contract WHERE name LIKE '[API_TEST]%';
