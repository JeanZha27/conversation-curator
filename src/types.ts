export type LifecycleStatus = "active" | "pending" | "completed" | "archived";
export type ValueLevel = "V0" | "V1" | "V2" | "V3";
export type SensitivityLevel = "S0" | "S1" | "S2" | "S3";

export type CanonicalConversation = {
  sourceConversationId: string;
  title: string;
  createdAt: string | null;
  updatedAt: string | null;
  messageCount: number;
  contentAvailable: boolean;
  sampledText: string[];
  branchMode: "current" | "all-messages-fallback";
};

export type SecurityScan = {
  sensitivityLevel: SensitivityLevel;
  hardMatch: boolean;
  candidateMatch: boolean;
  riskFlags: string[];
  matchCounts: Record<string, number>;
  redactedText: string;
};

export type ClassificationResult = {
  conversationId: string;
  taxonomyVersion: "mvp-1";
  primaryCategoryId: string;
  projectId: null;
  intent: string;
  deliverableType: string;
  lifecycleStatus: LifecycleStatus;
  valueLevel: ValueLevel;
  sensitivityLevel: SensitivityLevel;
  suggestedTitle: string;
  tags: string[];
  fieldConfidence: Record<string, number>;
  riskFlags: string[];
  reasonCodes: string[];
  requiresReview: boolean;
  classifierProvider: "heuristic-provider";
  classifierVersion: "mvp-1";
  createdAt: string;
};

export type SafeFailure = {
  itemIndex: number | null;
  code: string;
  message: string;
};

export type ConversationReportItem = {
  conversationRef: string;
  messageCount: number;
  branchMode: CanonicalConversation["branchMode"];
  security: Omit<SecurityScan, "redactedText">;
  classification: ClassificationResult;
};

export type ReportSource = {
  platform: "chatgpt";
  fileName: string;
  sha256: string;
  sizeBytes: number;
  modifiedAt: string;
};

export type ReportPrivacy = {
  networkUsed: false;
  rawMessageBodiesIncluded: false;
  originalTitlesIncluded: false;
  sensitiveValuesIncluded: boolean;
};

export type ReportSummary = {
  totalItems: number;
  classified: number;
  duplicates: number;
  failed: number;
  s3: number;
  s3Candidates: number;
  suggestedAccept: number;
  requiresReview: number;
};

export type ReportHeaderEvent = {
  type: "header";
  schemaVersion: "1.1";
  generatedAt: string;
  source: ReportSource;
};

export type ReportEvent =
  | ReportHeaderEvent
  | { type: "conversation"; data: ConversationReportItem }
  | { type: "failure"; data: SafeFailure }
  | { type: "summary"; summary: ReportSummary; privacy: ReportPrivacy };

export type CuratorRunResult = {
  header: ReportHeaderEvent;
  summary: ReportSummary;
  privacy: ReportPrivacy;
  previewConversations: ConversationReportItem[];
  previewFailures: SafeFailure[];
};
