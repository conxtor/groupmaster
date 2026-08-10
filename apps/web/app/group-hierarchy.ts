export type GroupHierarchyItem = {
  id: string;
  subject: string;
  parentGroupId?: string;
};

export type GroupHierarchyNode<T extends GroupHierarchyItem> = {
  group: T;
  children: GroupHierarchyNode<T>[];
};

export function buildGroupHierarchy<T extends GroupHierarchyItem>(groups: T[], visibleIds?: Set<string>) {
  const source = visibleIds ? groups.filter((group) => visibleIds.has(group.id)) : groups;
  const nodes = new Map(source.map((group) => [group.id, { group, children: [] as GroupHierarchyNode<T>[] }]));
  const roots: GroupHierarchyNode<T>[] = [];

  for (const node of nodes.values()) {
    const parent = node.group.parentGroupId ? nodes.get(node.group.parentGroupId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sortNodes = (items: GroupHierarchyNode<T>[]) => {
    items.sort((left, right) => left.group.subject.localeCompare(right.group.subject));
    for (const item of items) sortNodes(item.children);
  };
  sortNodes(roots);
  return roots;
}
