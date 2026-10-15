/** Lexical scope label only; the Server remains responsible for canonical paths. */
export function projectReference(projectPath: string, reference: string) {
  const normalize = (path: string) => {
    const parts: string[] = [];
    for (const part of path.split("/")) {
      if (part === "..") parts.pop();
      else if (part && part !== ".") parts.push(part);
    }
    return `/${parts.join("/")}`;
  };
  const project = normalize(projectPath);
  const path = normalize(
    reference.startsWith("/") ? reference : `${project}/${reference}`,
  );
  return {
    path,
    outside:
      project !== "/" && path !== project && !path.startsWith(`${project}/`),
  };
}
