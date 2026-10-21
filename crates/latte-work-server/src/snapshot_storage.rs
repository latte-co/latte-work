//! Private immutable snapshot objects. Large contents never enter SQLite JSON.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::{
    io::{BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

pub const RECORD_LIMIT: usize = 256 * 1024;
#[derive(Clone, Serialize, Deserialize)]
pub struct Object {
    key: String,
    size: u64,
    #[serde(skip)]
    root: PathBuf,
}
impl Object {
    pub fn key(&self) -> &str {
        &self.key
    }
    pub fn attach(&mut self, root: &Path) {
        self.root = root.to_owned();
    }
    pub fn path(&self) -> Result<PathBuf> {
        ensure!(
            self.key.len() == 64 && self.key.bytes().all(|c| c.is_ascii_hexdigit()),
            "快照引用无效"
        );
        ensure!(!self.root.as_os_str().is_empty(), "快照存储目录缺失");
        let path = self.root.join(&self.key);
        let metadata = path.symlink_metadata().context("快照对象缺失")?;
        ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() == self.size,
            "快照对象已改变"
        );
        Ok(path)
    }
    pub fn read<T: DeserializeOwned>(&self) -> Result<T> {
        let mut input = CheckedReader::new(self)?;
        let value = serde_json::from_reader(&mut input)?;
        input.finish()?;
        Ok(value)
    }
    pub fn copy_to(&self, path: &Path) -> Result<()> {
        let mut input = CheckedReader::new(self)?;
        std::io::copy(&mut input, &mut std::io::sink())?;
        input.finish()?;
        // Git reads immutable private objects through temporary hard links on
        // the same filesystem; avoid copying an entire changed tree again.
        if std::fs::hard_link(self.path()?, path).is_ok() {
            return Ok(());
        }
        let mut input = CheckedReader::new(self)?;
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        std::io::copy(&mut input, &mut output)?;
        input.finish()
    }
}
struct CheckedReader {
    input: BufReader<std::fs::File>,
    digest: Sha256,
    expected: String,
}
impl CheckedReader {
    fn new(object: &Object) -> Result<Self> {
        Ok(Self {
            input: BufReader::new(std::fs::File::open(object.path()?)?),
            digest: Sha256::new(),
            expected: object.key.clone(),
        })
    }
    fn finish(self) -> Result<()> {
        ensure!(
            format!("{:x}", self.digest.finalize()) == self.expected,
            "快照对象校验失败"
        );
        Ok(())
    }
}
impl Read for CheckedReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        let n = self.input.read(out)?;
        self.digest.update(&out[..n]);
        Ok(n)
    }
}
struct HashedWriter<W> {
    output: W,
    digest: Sha256,
    size: u64,
}
impl<W: Write> Write for HashedWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let n = self.output.write(bytes)?;
        self.digest.update(&bytes[..n]);
        self.size += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.output.flush()
    }
}
fn publish(temp: tempfile::NamedTempFile, root: &Path, key: String, size: u64) -> Result<Object> {
    temp.as_file().sync_all()?;
    match temp.persist_noclobber(root.join(&key)) {
        Ok(_) => {
            std::fs::File::open(root)?.sync_all()?;
        }
        Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.error.into()),
    }
    let object = Object {
        key,
        size,
        root: root.to_owned(),
    };
    object.path()?;
    Ok(object)
}
pub fn prepare(root: &Path) -> Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(root)?;
    ensure!(
        !root.symlink_metadata()?.file_type().is_symlink(),
        "快照目录不能是符号链接"
    );
    std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))?;
    Ok(root.canonicalize()?)
}
pub fn save_json(root: &Path, value: &impl Serialize) -> Result<Object> {
    let mut temp = tempfile::NamedTempFile::new_in(root)?;
    let mut writer = HashedWriter {
        output: BufWriter::new(temp.as_file_mut()),
        digest: Sha256::new(),
        size: 0,
    };
    serde_json::to_writer(&mut writer, value)?;
    writer.flush()?;
    let key = format!("{:x}", writer.digest.clone().finalize());
    let size = writer.size;
    drop(writer);
    publish(temp, root, key, size)
}
pub fn save_bytes(root: &Path, bytes: &[u8]) -> Result<Object> {
    let mut temp = tempfile::NamedTempFile::new_in(root)?;
    let mut writer = HashedWriter {
        output: BufWriter::new(temp.as_file_mut()),
        digest: Sha256::new(),
        size: 0,
    };
    writer.write_all(bytes)?;
    writer.flush()?;
    let key = format!("{:x}", writer.digest.clone().finalize());
    let size = writer.size;
    drop(writer);
    publish(temp, root, key, size)
}
pub async fn save_file(root: &Path, mut source: impl AsyncRead + Unpin) -> Result<Object> {
    let temp = tempfile::NamedTempFile::new_in(root)?;
    let mut output = tokio::fs::File::from_std(temp.reopen()?);
    let mut digest = Sha256::new();
    let mut size = 0;
    let mut chunk = vec![0; 64 * 1024];
    loop {
        let n = source.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        digest.update(&chunk[..n]);
        output.write_all(&chunk[..n]).await?;
        size += n as u64;
        tokio::task::yield_now().await;
    }
    output.flush().await?;
    output.sync_all().await?;
    drop(output);
    publish(temp, root, format!("{:x}", digest.finalize()), size)
}
#[derive(Clone, Serialize)]
#[serde(untagged)]
pub enum Contents {
    Legacy(Vec<u8>),
    Object(Object),
}
impl<'de> Deserialize<'de> for Contents {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = Contents;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("snapshot bytes or an object reference")
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<Contents, A::Error> {
                let mut bytes = Vec::new();
                while let Some(byte) = seq.next_element::<u8>()? {
                    bytes.try_reserve(1).map_err(serde::de::Error::custom)?;
                    bytes.push(byte);
                }
                Ok(Contents::Legacy(bytes))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                map: A,
            ) -> std::result::Result<Contents, A::Error> {
                Object::deserialize(serde::de::value::MapAccessDeserializer::new(map))
                    .map(Contents::Object)
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}
impl PartialEq for Contents {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Legacy(a), Self::Legacy(b)) => a == b,
            _ => self.digest() == other.digest(),
        }
    }
}
impl Contents {
    pub fn object(&self) -> Option<&Object> {
        if let Self::Object(object) = self {
            Some(object)
        } else {
            None
        }
    }
    fn digest(&self) -> String {
        match self {
            Self::Legacy(bytes) => format!("{:x}", Sha256::digest(bytes)),
            Self::Object(o) => o.key.clone(),
        }
    }
    pub fn len(&self) -> usize {
        match self {
            Self::Legacy(bytes) => bytes.len(),
            Self::Object(o) => usize::try_from(o.size).unwrap_or(usize::MAX),
        }
    }
    pub fn attach(&mut self, root: &Path) {
        if let Self::Object(o) = self {
            o.attach(root)
        }
    }
    pub fn write_to(&self, path: &Path) -> Result<()> {
        match self {
            Self::Legacy(bytes) => {
                std::fs::write(path, bytes)?;
                Ok(())
            }
            Self::Object(o) => o.copy_to(path),
        }
    }
    pub fn matches(&self, path: &Path) -> Result<bool> {
        let mut input = std::fs::File::open(path)?;
        let mut digest = Sha256::new();
        let mut chunk = [0; 16 * 1024];
        let mut count = 0;
        loop {
            let n = input.read(&mut chunk)?;
            if n == 0 {
                break;
            }
            count += n;
            digest.update(&chunk[..n]);
        }
        Ok(count == self.len() && format!("{:x}", digest.finalize()) == self.digest())
    }
    pub fn write_to_file(&self, file: &mut std::fs::File) -> Result<()> {
        match self {
            Self::Legacy(bytes) => file.write_all(bytes)?,
            Self::Object(o) => {
                let mut input = CheckedReader::new(o)?;
                std::io::copy(&mut input, file)?;
                input.finish()?;
            }
        }
        Ok(())
    }
}
/// Fallible bounded serialization for the small records stored under the database lock.
pub fn small_json(value: &impl Serialize) -> Result<String> {
    struct Limited(Vec<u8>);
    impl Write for Limited {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > RECORD_LIMIT.saturating_sub(self.0.len()) {
                return Err(std::io::Error::other("快照元数据过大"));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut out = Limited(Vec::new());
    serde_json::to_writer(&mut out, value)?;
    String::from_utf8(out.0).context("快照元数据编码失败")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sqlite_record_guard_rejects_before_serializing_an_unbounded_record() {
        assert!(small_json(&vec![0u8; RECORD_LIMIT]).is_err());
        assert!(small_json(&vec![0u8; 1024]).unwrap().len() < RECORD_LIMIT);
    }
    #[tokio::test]
    async fn corrupted_disk_objects_are_never_used_for_restoration() {
        let directory = tempfile::tempdir().unwrap();
        let root = prepare(directory.path()).unwrap();
        let object = save_file(&root, tokio::io::repeat(42).take(1024 * 1024))
            .await
            .unwrap();
        let path = object.path().unwrap();
        let mut file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        file.write_all(b"x").unwrap();
        assert!(object.copy_to(&root.join("copy")).is_err());
    }
}
