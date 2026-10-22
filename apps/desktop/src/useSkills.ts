import { useEffect, useRef, useState } from "react";
import { message, request } from "./api";
import type { ManagedSkill, Response, SkillState } from "./protocol";
import type { Workbench } from "./useWorkbench";
export type SkillChange = { skill: ManagedSkill; next: SkillState };
type Catalog = Extract<Response, { kind: "skills" }>;
type Detail = Extract<Response, { kind: "skill_detail" }>;
function upgradeMessage(hostName: string, remote: boolean) {
  return `${hostName} 的 Server 版本较旧，尚不支持技能管理。请${remote ? "在该远程主机上更新并重启同版本 Server，再重新连接" : "更新本机 Server 后重新连接"}；重启前请先完成任务并关闭终端。`;
}

export function useSkills(
  state: Workbench,
  active: boolean,
  onBusy: (busy: boolean) => void,
) {
  const [hostId, setHostId] = useState(state.host.id);
  const [catalog, setCatalog] = useState<Catalog>();
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({
    catalog: "",
    detail: "",
    operation: "",
  });
  const clearErrors = () =>
    setErrors({ catalog: "", detail: "", operation: "" });
  const setDetailError = (detail: string) =>
    setErrors((current) => ({ ...current, detail }));
  const setOperationError = (operation: string) =>
    setErrors((current) => ({ ...current, operation }));
  const [notice, setNotice] = useState("");
  const [detail, setDetail] = useState<Detail>();
  const [selected, setSelected] = useState<string>();
  const [confirm, setConfirm] = useState<SkillChange>();
  const [add, setAdd] = useState(false);
  const refresh = useRef<HTMLButtonElement>(null);
  const selectionTrigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const generation = useRef(0);
  const operation = useRef(false);
  const host = state.hosts.find((h) => h.id === hostId);
  const connected = !!host && state.isHostConnected(hostId);
  const supported = state.hostSupportsSkills(hostId);
  const upgrade = upgradeMessage(host?.name ?? "所选主机", hostId !== "local");
  const context = `${supported}:${hostId}:${state.hostConnectionVersions[hostId] ?? 0}:${active}:${connected}`;
  const describeError = (cause: unknown) => message(cause);
  const contextRef = useRef(context);
  // Invalidate during render as well as effect cleanup: stale async results cannot mutate a new scope.
  if (contextRef.current !== context) {
    contextRef.current = context;
    generation.current++;
  }

  useEffect(() => {
    setDetail(undefined);
    setSelected(undefined);
    setConfirm(undefined);
    setAdd(false);
    setCatalog(undefined);
    clearErrors();
    setNotice("");
    if (!active || !connected) {
      setLoading(false);
      return;
    }
    if (!supported) {
      setLoading(false);
      setErrors((current) => ({ ...current, catalog: upgrade }));
      return;
    }
    const version = ++generation.current;
    setLoading(true);
    void request(hostId, { method: "skills", project_id: null })
      .then((response) => {
        if (version !== generation.current) return;
        if (response.kind !== "skills") throw new Error(upgrade);
        setCatalog(response);
      })
      .catch((cause) => {
        if (version === generation.current)
          setErrors((current) => ({
            ...current,
            catalog: describeError(cause),
          }));
      })
      .finally(() => {
        if (version === generation.current) setLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, [context, revision]);
  useEffect(() => {
    if (!active || !selected) return;
    const version = generation.current;
    let disposed = false;
    setDetail(undefined);
    void request(hostId, {
      method: "skill_detail",
      project_id: null,
      id: selected,
    })
      .then((response) => {
        if (disposed || version !== generation.current) return;
        if (response.kind !== "skill_detail")
          throw new Error("技能详情暂不可用，请更新 Server");
        setDetail(response);
      })
      .catch((cause) => {
        if (!disposed && version === generation.current)
          setDetailError(describeError(cause));
      });
    return () => {
      disposed = true;
    };
  }, [selected, context]);

  async function mutate(
    action: { skill: ManagedSkill; next: SkillState } | { path: string },
  ) {
    if (operation.current || !connected) return;
    operation.current = true;
    const version = generation.current;
    setBusy(true);
    onBusy(true);
    clearErrors();
    setNotice("");
    try {
      const response = await request(
        hostId,
        "skill" in action
          ? {
              method: "set_skill_state",
              project_id: null,
              id: action.skill.id,
              state: action.next,
              expected_state: action.skill.state,
            }
          : {
              method: "install_skill",
              project_id: null,
              scope: "system",
              path: action.path.trim(),
            },
      );
      if (version !== generation.current) return;
      if (response.kind !== "skills")
        throw new Error("操作结果待核对，请刷新列表确认状态");
      restoreFocus.current = !!selected;
      setCatalog(response);
      setConfirm(undefined);
      setAdd(false);
      setSelected(undefined);
      setDetail(undefined);
      setNotice("已保存。对后续新建的 Agent 会话生效。");
    } catch (cause) {
      if (version === generation.current)
        setOperationError(
          `${describeError(cause)}。可刷新列表核对状态；不会自动重试操作。`,
        );
    } finally {
      operation.current = false;
      setBusy(false);
      onBusy(false);
    }
  }
  function change(skill: ManagedSkill, next: SkillState) {
    setOperationError("");
    if (skill.scope !== "platform" || next === "uninstalled")
      setConfirm({ skill, next });
    else void mutate({ skill, next });
  }
  function selectSkill(skill: ManagedSkill, trigger: HTMLButtonElement) {
    selectionTrigger.current = trigger;
    clearErrors();
    setSelected(skill.id);
  }
  useEffect(() => {
    if (!restoreFocus.current || selected) return;
    restoreFocus.current = false;
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const trigger = selectionTrigger.current;
      if (
        trigger?.isConnected &&
        !trigger.disabled &&
        !trigger.closest("[hidden], [inert]")
      )
        trigger.focus();
      else refresh.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, active]);
  return {
    hostId,
    setHostId,
    host,
    connected,
    catalog,
    loading,
    busy,
    notice,
    pageError: errors.catalog,
    detailError: errors.operation || errors.detail,
    operationError: errors.operation,
    setDetailError,
    clearErrors,
    detail,
    selected,
    setSelected,
    setDetail,
    confirm,
    setConfirm,
    add,
    setAdd,
    refresh,
    operation,
    context,
    reload: () => setRevision((value) => value + 1),
    mutate,
    change,
    selectSkill,
  };
}
