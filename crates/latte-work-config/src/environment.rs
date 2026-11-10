//! Validation shared by App persistence and the execution host.
use anyhow::{Result, bail};
use latte_work_protocol::AgentEnvironment;

pub fn validate_agent_environment(environment: &AgentEnvironment) -> Result<()> {
    if environment.0.len() > 64 {
        bail!("环境变量最多 64 项");
    }
    let mut bytes = 0;
    for (name, value) in &environment.0 {
        let mut chars = name.bytes();
        if name.len() > 255
            || !chars
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
            || !chars.all(|c| c.is_ascii_alphanumeric() || c == b'_')
        {
            bail!("环境变量名称必须以字母或下划线开头，且只能包含字母、数字和下划线");
        }
        if matches!(
            name.as_str(),
            "HOME" | "USER" | "LOGNAME" | "SHELL" | "PWD" | "OLDPWD" | "SHLVL" | "_"
        ) || name.starts_with("LATTE_WORK_")
        {
            bail!("不能覆盖主机身份、工作目录或 LATTE_WORK_ 环境变量");
        }
        if value.contains('\0') || value.len() > 8192 {
            bail!("环境变量值不能包含 NUL，且每项最多 8 KiB");
        }
        bytes += name.len() + value.len() + 2;
    }
    if bytes > 32 * 1024 {
        bail!("环境变量总大小最多 32 KiB");
    }
    Ok(())
}
