//! One skill filesystem operation at a time, independent of Agent probe capacity.
use anyhow::{Context, Result, bail};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;

#[derive(Clone)]
pub struct Budget {
    deadline: Instant,
    cancelled: Arc<AtomicBool>,
}
impl Budget {
    pub(crate) fn new(limit: Duration) -> Self {
        Self {
            deadline: Instant::now() + limit,
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }
    pub fn check(&self) -> Result<()> {
        if self.cancelled.load(Ordering::Acquire) || Instant::now() >= self.deadline {
            bail!("Skill 操作已超时或取消，请刷新核对状态");
        }
        Ok(())
    }
}
struct CancelOnDrop(Budget);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancelled.store(true, Ordering::Release);
    }
}
#[derive(Clone)]
pub struct Worker {
    admission: Arc<Semaphore>,
}
impl Worker {
    pub fn new() -> Self {
        Self {
            admission: Arc::new(Semaphore::new(1)),
        }
    }
    pub async fn run<T, F>(&self, work: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(Budget) -> Result<T> + Send + 'static,
    {
        self.run_with_limit(Duration::from_secs(15), work).await
    }
    async fn run_with_limit<T, F>(&self, limit: Duration, work: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(Budget) -> Result<T> + Send + 'static,
    {
        let permit = self
            .admission
            .clone()
            .try_acquire_owned()
            .context("技能请求仍在进行，请稍后刷新核对")?;
        let budget = Budget::new(limit);
        // Also cancel cooperatively when a disconnected caller drops this future.
        let _cancel = CancelOnDrop(budget.clone());
        let task = tokio::task::spawn_blocking(move || {
            // A started blocking syscall cannot be aborted. Retain the slot until
            // it really exits, rather than admitting an unbounded number of workers.
            let _permit = permit;
            budget.check()?;
            work(budget)
        });
        tokio::time::timeout(limit, task)
            .await
            .context("Skill 操作响应超时，结果待核对；请刷新列表，勿重复操作")?
            .context("Skill 工作线程异常")?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn timeout_retains_the_worker_slot_and_cancels_before_late_mutation() {
        let worker = Worker::new();
        let (started, start) = oneshot::channel();
        let (release, wait) = oneshot::channel();
        let (finished, finish) = oneshot::channel();
        let running = worker.clone();
        let job = tokio::spawn(async move {
            running
                .run_with_limit(Duration::from_millis(500), move |budget| {
                    started.send(()).unwrap();
                    let _ = wait.blocking_recv();
                    let cancelled = budget.check().is_err();
                    let _ = finished.send(cancelled);
                    budget.check()
                })
                .await
        });
        start.await.unwrap();
        assert!(
            job.await
                .unwrap()
                .unwrap_err()
                .to_string()
                .contains("响应超时")
        );
        assert!(
            worker
                .run(|_| Ok(()))
                .await
                .unwrap_err()
                .to_string()
                .contains("仍在进行")
        );
        release.send(()).unwrap();
        assert!(finish.await.unwrap());
        tokio::time::timeout(Duration::from_secs(2), async {
            while worker.admission.available_permits() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(worker.run(|_| Ok(7)).await.unwrap(), 7);
    }

    #[tokio::test]
    async fn dropping_a_request_cancels_work_without_releasing_its_running_slot() {
        let worker = Worker::new();
        let (started, start) = oneshot::channel();
        let (release, wait) = oneshot::channel();
        let (finished, finish) = oneshot::channel();
        let running = worker.clone();
        let job = tokio::spawn(async move {
            running
                .run(move |budget| {
                    started.send(()).unwrap();
                    let _ = wait.blocking_recv();
                    let _ = finished.send(budget.check().is_err());
                    Ok(())
                })
                .await
        });
        start.await.unwrap();
        job.abort();
        assert!(job.await.unwrap_err().is_cancelled());
        assert_eq!(worker.admission.available_permits(), 0);
        release.send(()).unwrap();
        assert!(finish.await.unwrap());
    }
}
