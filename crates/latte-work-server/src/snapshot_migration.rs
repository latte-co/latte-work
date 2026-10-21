//! Archive legacy oversized SQLite snapshot rows without materializing their JSON.
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;

pub fn migrate(db: &Connection, directory: &Path) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS snapshot_legacy_archive(source_table TEXT NOT NULL,source_column TEXT NOT NULL,source_rowid INTEGER NOT NULL,path TEXT NOT NULL,PRIMARY KEY(path));")?;
    for (table, column) in [
        ("task_baselines", "data"),
        ("turn_changes", "baseline"),
        ("turn_changes", "data"),
    ] {
        let mut last_rowid = 0;
        loop {
            let row:Option<(i64,i64,String,Option<String>)>=db.query_row(
                &format!("SELECT rowid,octet_length({column}),session_id,{} FROM {table} WHERE octet_length({column})>?1 AND rowid>?2 ORDER BY rowid LIMIT 1",if table=="turn_changes"{"request_id"}else{"NULL"}),
                params![crate::snapshot_storage::RECORD_LIMIT as i64,last_rowid],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
            let Some((rowid, size, session, request)) = row else {
                break;
            };
            let archive = crate::snapshot_storage::prepare(&directory.join("legacy"))?;
            let mut file = tempfile::NamedTempFile::new_in(&archive)?;
            let mut blob = db.blob_open("main", table, column, rowid, true)?;
            anyhow::ensure!(blob.len() as i64 == size, "旧快照在迁移时已改变");
            std::io::copy(&mut blob, &mut file)?;
            drop(blob);
            file.as_file().sync_all()?;
            let name = format!("{}.json", uuid::Uuid::new_v4());
            let path = archive.join(&name);
            file.persist_noclobber(&path)?;
            std::fs::File::open(&archive)?.sync_all()?;
            let unavailable = "旧版大型快照已完整归档，自动撤销状态未知；请核对工作区。";
            let snapshot = crate::task_changes::Snapshot::unavailable(unavailable.into());
            let fallback = if table == "turn_changes" && column == "data" {
                serde_json::to_string(
                    &serde_json::json!({"changes":{"request_id":request,"summary":{"entries":[],"added":0,"removed":0,"binary_files":0,"truncated":false,"baseline_at":null,"unavailable":unavailable},"interrupted":true,"background_pending":false,"undo":"unknown"},"before":snapshot,"after":snapshot}),
                )?
            } else {
                serde_json::to_string(&snapshot)?
            };
            // Decode only a bounded legacy record, outside the runtime database
            // mutex. This preserves normal pre-object-store history. Larger or
            // malformed records retain the raw archive and an explicit unknown.
            const LEGACY_DECODE_LIMIT: i64 = 96 * 1024 * 1024;
            let converted = (|| -> Result<String> {
                anyhow::ensure!(size <= LEGACY_DECODE_LIMIT, "legacy decode budget exceeded");
                let input = std::io::BufReader::new(std::fs::File::open(&path)?);
                if table == "turn_changes" && column == "data" {
                    let turn: crate::task_changes::FrozenTurn = serde_json::from_reader(input)?;
                    crate::snapshot_storage::small_json(&turn.migrate_legacy(directory)?)
                } else {
                    let snapshot: crate::task_changes::Snapshot = serde_json::from_reader(input)?;
                    crate::snapshot_storage::small_json(&snapshot.migrate_legacy(directory)?)
                }
            })();
            let recovered = converted.is_ok();
            let replacement = converted.unwrap_or(fallback);
            let tx = db.unchecked_transaction()?;
            tx.execute("INSERT INTO snapshot_legacy_archive(source_table,source_column,source_rowid,path) VALUES (?1,?2,?3,?4)",params![table,column,rowid,name])?;
            tx.execute(
                &format!("UPDATE {table} SET {column}=?2 WHERE rowid=?1"),
                params![rowid, replacement],
            )?;
            tx.execute(
                "INSERT INTO events(session_id,at,data) VALUES (?1,?2,?3)",
                params![
                    session,
                    crate::store::now(),
                    serde_json::to_string(&latte_work_protocol::EventKind::Notice {
                        text: if recovered {
                            "旧版快照已迁移到独立存储，原始记录已归档。".into()
                        } else {
                            unavailable.into()
                        }
                    })?
                ],
            )?;
            tx.commit()?;
            last_rowid = rowid;
        }
    }
    Ok(())
}
