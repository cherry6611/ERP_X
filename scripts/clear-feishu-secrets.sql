-- 轮换顺序：先备份数据库，在旧 SECRET_ENC_KEY 仍可用时执行本脚本清空密文，
-- 然后才更换主密钥，最后由管理员在配置接口重新写入新的飞书应用密钥。
-- 顺序反了，enc1 密文无法还原。本脚本不包含任何密钥值。

UPDATE comp_feishu_drive_config
SET app_secret = '',
    app_secret_prev = NULL,
    app_id = '',
    secret_prev_version = secret_key_version,
    secret_rotated_at = CURRENT_TIMESTAMP;

UPDATE sys_login_session
SET refresh_token_enc = NULL,
    revoked_at = CURRENT_TIMESTAMP
WHERE revoked_at IS NULL;
