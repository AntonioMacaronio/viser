import { createPortal } from "@react-three/fiber";
import React from "react";
import * as THREE from "three";

import { CoordinateFrame } from "./ThreeAssets";

import { immerable } from "immer";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

// The covariance/contravariance rules are too complicated here, so we just
// type the reference with any.
export type MakeObject = (ref: React.RefObject<any>) => React.ReactNode;

/** Scenes will consist of nodes, which form a tree. */
export class SceneNode {
  [immerable] = true;

  public children: string[];

  constructor(public name: string, public make_object: MakeObject) {
    this.children = [];
  }
}

interface SceneTreeState {
  nodeFromName: { [key: string]: SceneNode };
  visibilityFromName: { [key: string]: boolean };
  matrixFromName: { [key: string]: THREE.Matrix4 };
  objFromName: { [key: string]: THREE.Object3D };
}
export interface SceneTreeActions extends SceneTreeState {
  setObj(name: string, obj: THREE.Object3D): void;
  setVisibility(name: string, visible: boolean): void;
  setMatrix(name: string, matrix: THREE.Matrix4): void;
  clearObj(name: string): void;
  addSceneNode(nodes: SceneNode): void;
  removeSceneNode(name: string): void;
  resetScene(): void;
}

// Create default scene tree state.
// By default, the y-axis is up. Let's rotate everything so Z is up instead.
const rootFrameTemplate: MakeObject = (ref) => (
  <CoordinateFrame
    ref={ref}
    show_axes={false}
    quaternion={new THREE.Quaternion().setFromEuler(
      new THREE.Euler(-Math.PI / 2.0, 0.0, 0.0)
    )}
  />
);
const rootAxesTemplate: MakeObject = (ref) => <CoordinateFrame ref={ref} />;

const rootNodeTemplate = new SceneNode("", rootFrameTemplate);
const rootAxesNode = new SceneNode("/WorldAxes", rootAxesTemplate);
rootNodeTemplate.children.push("/WorldAxes");

const cleanSceneTreeState = {
  nodeFromName: { "": rootNodeTemplate, "/WorldAxes": rootAxesNode },
  visibilityFromName: { "": true, "/WorldAxes": true },
  matrixFromName: {},
  objFromName: {},
} as SceneTreeState;

/** Declare a scene state, and return a hook for accessing it. Note that we put
effort into avoiding a global state! */
export function useSceneTreeState() {
  return React.useState(() =>
    create(
      immer<SceneTreeState & SceneTreeActions>((set) => ({
        ...cleanSceneTreeState,
        setObj: (name, obj) =>
          set((state) => {
            state.objFromName[name] = obj;
          }),
        setVisibility: (name, visible) =>
          set((state) => {
            state.visibilityFromName[name] = visible;
          }),
        setMatrix: (name, matrix) =>
          set((state) => {
            state.matrixFromName[name] = matrix;
          }),
        clearObj: (name) =>
          set((state) => {
            delete state.objFromName[name];
          }),
        addSceneNode: (node) =>
          set((state) => {
            if (node.name in state.nodeFromName) {
              state.nodeFromName[node.name] = {
                ...node,
                children: state.nodeFromName[node.name].children,
              };
            } else {
              const parent_name = node.name.split("/").slice(0, -1).join("/");
              state.nodeFromName[node.name] = node;
              state.nodeFromName[parent_name].children.push(node.name);
              if (!(node.name in state.visibilityFromName))
                state.visibilityFromName[node.name] = true;
            }
          }),
        removeSceneNode: (name) =>
          set((state) => {
            if (!(name in state.nodeFromName)) {
              console.log("Skipping scene node removal for " + name);
              return;
            }
            // Remove node from parent's children list.
            const parent_name = name.split("/").slice(0, -1).join("/");

            state.nodeFromName[parent_name].children = state.nodeFromName[
              parent_name
            ].children.filter((child_name) => child_name !== name);

            delete state.visibilityFromName[name];
            delete state.matrixFromName[name];

            // If we want to remove "/tree", we should remove all of "/tree", "/tree/trunk", "/tree/branch", etc.
            const remove_names = Object.keys(state.nodeFromName).filter((n) =>
              n.startsWith(name)
            );
            remove_names.forEach((remove_name) => {
              delete state.nodeFromName[remove_name];
            });
          }),
        resetScene: () =>
          set((state) => {
            state = { ...state, ...cleanSceneTreeState }; // eslint-disable-line @typescript-eslint/no-unused-vars
          }),
      }))
    )
  )[0];
}

/** Type corresponding to a zustand-style useSceneTree hook. */
export type UseSceneTree = ReturnType<typeof useSceneTreeState>;

function SceneNodeThreeChildren(props: {
  name: string;
  useSceneTree: UseSceneTree;
}) {
  const children = props.useSceneTree(
    (state) => state.nodeFromName[props.name].children
  );
  const parentObj = props.useSceneTree(
    (state) => state.objFromName[props.name]
  );

  // Create a group of children inside of the parent object.
  return (
    parentObj &&
    createPortal(
      <group>
        {children.map((child_id) => {
          return (
            <SceneNodeThreeObject
              key={child_id}
              name={child_id}
              useSceneTree={props.useSceneTree}
            />
          );
        })}
      </group>,
      parentObj
    )
  );
}

/** Component containing the three.js object and children for a particular scene node. */
export const SceneNodeThreeObject = React.memo(
  // This memo is very important for big scenes!!
  function SceneNodeThreeObject(props: {
    name: string;
    useSceneTree: UseSceneTree;
  }) {
    const sceneNode = props.useSceneTree(
      (state) => state.nodeFromName[props.name]
    );
    const setObj = props.useSceneTree((state) => state.setObj);
    const clearObj = props.useSceneTree((state) => state.clearObj);
    const ref = React.useRef<THREE.Object3D>(null);

    React.useEffect(() => {
      ref.current && setObj(props.name, ref.current);
      return () => clearObj(props.name);
    });

    return (
      <>
        {sceneNode.make_object(ref)}
        <SceneNodeUpdater
          name={props.name}
          objRef={ref}
          useSceneTree={props.useSceneTree}
        />
        <SceneNodeThreeChildren
          name={props.name}
          useSceneTree={props.useSceneTree}
        />
      </>
    );
  }
);

/** Shove visibility updates into a separate components so the main object
 * component doesn't need to be repeatedly re-rendered.*/
function SceneNodeUpdater(props: {
  name: string;
  objRef: React.RefObject<THREE.Object3D>;
  useSceneTree: UseSceneTree;
}) {
  const visible = props.useSceneTree(
    (state) => state.visibilityFromName[props.name]
  );
  const matrix = props.useSceneTree(
    (state) => state.matrixFromName[props.name]
  );
  React.useEffect(() => {
    if (props.objRef.current === null) return;
    props.objRef.current.visible = visible;
    matrix && props.objRef.current.matrix.copy(matrix);
  }, [props, visible, matrix]);
  return <></>;
}