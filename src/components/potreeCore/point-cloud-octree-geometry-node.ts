/**
 * Adapted from Potree.js http://potree.org
 * Potree License: https://github.com/potree/potree/blob/1.5/LICENSE
 */

import { Box3, BufferGeometry, EventDispatcher, Sphere, Vector3 } from "three";
import { PointCloudOctreeGeometry } from "./point-cloud-octree-geometry";
import { IPointCloudTreeNode } from "./types";
import { createChildAABB } from "./utils/bounds";
import { getIndexFromName } from "./utils/utils";

export interface NodeData {
  children: number;
  numPoints: number;
  name: string;
}

const NODE_STRIDE = 5;

export class PointCloudOctreeGeometryNode
  extends EventDispatcher
  implements IPointCloudTreeNode
{
  public id: number = PointCloudOctreeGeometryNode.idCount++;

  public name: string;

  public pcoGeometry: PointCloudOctreeGeometry;

  public index: number;

  public level: number = 0;

  public spacing: number = 0;

  public hasChildren: boolean = false;

  readonly children: ReadonlyArray<PointCloudOctreeGeometryNode | null> = [
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ];

  public boundingBox: Box3;

  public tightBoundingBox: Box3;

  public boundingSphere: Sphere;

  public mean: Vector3 = new Vector3();

  public numPoints: number = 0;

  public geometry: BufferGeometry | undefined;

  public loaded: boolean = false;

  public loading: boolean = false;

  public failed: boolean = false;

  public parent: PointCloudOctreeGeometryNode | null = null;

  public oneTimeDisposeHandlers: (() => void)[] = [];

  public isLeafNode: boolean = true;

  readonly isTreeNode: boolean = false;

  readonly isGeometryNode: boolean = true;

  private static idCount = 0;

  constructor(
    name: string,
    pcoGeometry: PointCloudOctreeGeometry,
    boundingBox: Box3,
  ) {
    super();

    this.name = name;
    this.index = getIndexFromName(name);
    this.pcoGeometry = pcoGeometry;
    this.boundingBox = boundingBox;
    this.tightBoundingBox = boundingBox.clone();
    this.boundingSphere = boundingBox.getBoundingSphere(new Sphere());
  }

  dispose(): void {
    if (!this.geometry || !this.parent) {
      return;
    }

    this.geometry.dispose();
    this.geometry = undefined;
    this.loaded = false;

    this.oneTimeDisposeHandlers.forEach((handler) => {
      return handler();
    });
    this.oneTimeDisposeHandlers = [];
  }

  /**
   * Gets the url of the binary file for this node.
   */
  getUrl(): string {
    const geometry = this.pcoGeometry;
    const version = geometry.loader.version;
    const pathParts = [geometry.octreeDir];

    if (geometry.loader && version.equalOrHigher("1.5")) {
      pathParts.push(this.getHierarchyBaseUrl());
      pathParts.push(this.name);
    } else if (version.equalOrHigher("1.4")) {
      pathParts.push(this.name);
    } else if (version.upTo("1.3")) {
      pathParts.push(this.name);
    }

    return pathParts.join("/");
  }

  /**
   * Gets the url of the hierarchy file for this node.
   */
  public getHierarchyUrl(): string {
    return `${this.pcoGeometry.octreeDir}/${this.getHierarchyBaseUrl()}/${
      this.name
    }.hrc`;
  }

  /**
   * Adds the specified node as a child of the current node.
   *
   * @param child - The node which is to be added as a child.
   */
  public addChild(child: PointCloudOctreeGeometryNode): void {
    (this.children as any)[child.index] = child;
    this.isLeafNode = false;
    child.parent = this;
  }

  /**
   * Calls the specified callback for the current node (if includeSelf is set to true) and all its children.
   *
   * @param cb - The function which is to be called for each node.
   */
  public traverse(
    cb: (node: PointCloudOctreeGeometryNode) => void,
    includeSelf = true,
  ): void {
    const stack: PointCloudOctreeGeometryNode[] = includeSelf ? [this] : [];

    let current: PointCloudOctreeGeometryNode | undefined;

    while ((current = stack.pop()) !== undefined) {
      cb(current);

      for (const child of current.children) {
        if (child !== null) {
          stack.push(child);
        }
      }
    }
  }

  public load(): Promise<void> {
    if (!this.canLoad()) {
      return Promise.resolve();
    }

    this.loading = true;
    this.pcoGeometry.numNodesLoading++;
    this.pcoGeometry.needsUpdate = true;

    let promise: Promise<void>;

    if (
      this.pcoGeometry.loader.version.equalOrHigher("1.5") &&
      this.level % this.pcoGeometry.hierarchyStepSize === 0 &&
      this.hasChildren
    ) {
      promise = this.loadHierachyThenPoints();
    } else {
      promise = this.loadPoints();
    }

    return promise.catch((reason) => {
      this.loading = false;
      this.failed = true;
      this.pcoGeometry.numNodesLoading--;
      throw reason;
    });
  }

  private canLoad(): boolean {
    return (
      !this.loading &&
      !this.loaded &&
      !this.pcoGeometry.disposed &&
      !this.pcoGeometry.loader.disposed &&
      this.pcoGeometry.numNodesLoading < this.pcoGeometry.maxNumNodesLoading
    );
  }

  private loadPoints(): Promise<void> {
    this.pcoGeometry.needsUpdate = true;
    return this.pcoGeometry.loader.load(this);
  }

  private loadHierachyThenPoints(): Promise<any> {
    if (this.level % this.pcoGeometry.hierarchyStepSize !== 0) {
      return Promise.resolve();
    }

    return Promise.resolve(
      this.pcoGeometry.loader.getUrl(this.getHierarchyUrl()),
    )
      .then((url) => {
        return this.pcoGeometry.xhrRequest(url, { mode: "cors" });
      })
      .then((res) => {
        return res.arrayBuffer();
      })
      .then((data) => {
        return this.loadHierarchy(this, data);
      });
  }

  /**
   * Gets the url of the folder where the hierarchy is, relative to the octreeDir.
   */
  private getHierarchyBaseUrl(): string {
    const hierarchyStepSize = this.pcoGeometry.hierarchyStepSize;
    const indices = this.name.substr(1);
    const numParts = Math.floor(indices.length / hierarchyStepSize);

    let path = "r/";
    for (let i = 0; i < numParts; i++) {
      path += `${indices.substr(i * hierarchyStepSize, hierarchyStepSize)}/`;
    }

    return path.slice(0, -1);
  }

  // tslint:disable:no-bitwise
  private loadHierarchy(
    node: PointCloudOctreeGeometryNode,
    buffer: ArrayBuffer,
  ) {
    const view = new DataView(buffer);

    const firstNodeData = this.getNodeData(node.name, 0, view);
    node.numPoints = firstNodeData.numPoints;

    // Nodes which need be visited.
    const stack: NodeData[] = [firstNodeData];
    // Nodes which have already been decoded. We will take nodes from the stack and place them here.
    const decoded: NodeData[] = [];

    let offset = NODE_STRIDE;
    while (stack.length > 0) {
      const stackNodeData = stack.shift()!;

      // From the last bit, all the way to the 8th one from the right.
      let mask = 1;
      for (let i = 0; i < 8 && offset + 1 < buffer.byteLength; i++) {
        if ((stackNodeData.children & mask) !== 0) {
          const nodeData = this.getNodeData(
            stackNodeData.name + i,
            offset,
            view,
          );

          decoded.push(nodeData); // Node is decoded.
          stack.push(nodeData); // Need to check its children.

          offset += NODE_STRIDE; // Move over to the next node in the buffer.
        }

        mask = mask * 2;
      }
    }

    node.pcoGeometry.needsUpdate = true;

    // Map containing all the nodes.
    const nodes = new Map<string, PointCloudOctreeGeometryNode>();
    nodes.set(node.name, node);
    decoded.forEach((nodeData) => {
      return this.addNode(nodeData, node.pcoGeometry, nodes);
    });

    node.loadPoints();
  }

  // tslint:enable:no-bitwise

  private getNodeData(name: string, offset: number, view: DataView): NodeData {
    const children = view.getUint8(offset);
    const numPoints = view.getUint32(offset + 1, true);
    return { children: children, numPoints: numPoints, name: name };
  }

  addNode(
    { name, numPoints, children }: NodeData,
    pco: PointCloudOctreeGeometry,
    nodes: Map<string, PointCloudOctreeGeometryNode>,
  ): void {
    const index = getIndexFromName(name);
    const parentName = name.substring(0, name.length - 1);
    const parentNode = nodes.get(parentName)!;
    const level = name.length - 1;
    const boundingBox = createChildAABB(parentNode.boundingBox, index);

    const node = new PointCloudOctreeGeometryNode(name, pco, boundingBox);
    node.level = level;
    node.numPoints = numPoints;
    node.hasChildren = children > 0;
    node.spacing = pco.spacing / Math.pow(2, level);

    parentNode.addChild(node);
    nodes.set(name, node);
  }
}
