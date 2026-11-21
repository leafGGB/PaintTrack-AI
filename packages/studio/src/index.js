"use client";

export { default as AssetsStudio } from './components/AssetsStudio';
export { default as ImageStudio } from './components/ImageStudio';
export { default as VideoStudio } from './components/VideoStudio';
export { default as ClippingStudio } from './components/ClippingStudio';
export { default as VibeMotionStudio } from './components/VibeMotionStudio';
export { default as LipSyncStudio } from './components/LipSyncStudio';
export { default as RecastStudio } from './components/RecastStudio';
export { default as CinemaStudio } from './components/CinemaStudio';
export { default as AudioStudio } from './components/AudioStudio';
export { default as MarketingStudio } from './components/MarketingStudio';
export { default as WorkflowStudio } from './components/WorkflowStudio';
export { default as AgentStudio } from './components/AgentStudio';
export { default as DesignAgentStudio } from './components/DesignAgentStudio';
export { default as AppsStudio } from './components/AppsStudio';
export { default as McpCliStudio } from './components/McpCliStudio';
export { default as AiInfluencerStudio } from './components/AiInfluencerStudio';
export { default as LayersStudio } from './components/LayersStudio';
export { default as MotionControlStudio } from './components/MotionControlStudio';

// Shared UI primitives. `ConfirmDialog` replaces window.confirm(): app-styled,
// accessible (alertdialog + focus trap + focus restore), and able to show an
// in-flight/error state. Reuse this instead of writing another overlay.
export { default as ConfirmDialog } from './components/ui/ConfirmDialog';
export * from './muapi';
