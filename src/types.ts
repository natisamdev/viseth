export type AppRole = 'traveler' | 'guide' | 'gatekeeper';
export type AdminRole = 'place_admin' | 'super_admin';
export type UserStatus = 'active' | 'pending' | 'suspended';

export type AttractionCategory =
  | 'museum'
  | 'heritage'
  | 'park'
  | 'natural'
  | 'culture';

export type TicketStatus =
  | 'pending_payment'
  | 'valid'
  | 'used'
  | 'voided'
  | 'expired';

export type GiftStatus =
  | 'pending_payment'
  | 'active'
  | 'partially_used'
  | 'fully_used'
  | 'revoked'
  | 'expired';

export type TransactionKind = 'ticket' | 'gift' | 'booking' | 'hotel';
export type TransactionStatus = 'pending' | 'succeeded' | 'failed' | 'refunded';
export type BookingStatus =
  | 'requested'
  | 'confirmed'
  | 'declined'
  | 'cancelled'
  | 'completed';

export type RecapStatus = 'published' | 'flagged' | 'removed';

export interface StreakTier {
  id: string;
  badgeName: string;
  item: string;
  minMonths: number;
  maxMonths: number | null;
  requiresAllRegions?: boolean;
}

export interface FollowerTitle {
  id: string;
  title: string;
  amharic: string;
  minFollowers: number;
  maxFollowers: number | null;
}

export interface PlatformSettings {
  commissionRate: number;
  payoutDay: number;
  supportEmail: string;
  maintenanceMode: boolean;
  giftKeycodeExpiryHours: number;
  ticketExpiryHours: number;
  platformFeePercent: number;
  totalRegions: number;
}

export interface FeatureFlags {
  diaspora_gifting: boolean;
  ai_recaps: boolean;
  guide_booking: boolean;
  streak_badges: boolean;
  discovery_feed: boolean;
  live_streaming: boolean;
  hotels: boolean;
}

export interface UserDoc {
  id: string;
  firebaseUid: string;
  email: string | null;
  phone: string | null;
  displayName: string;
  username: string | null;
  photoUrl: string | null;
  bio: string;
  region: string | null;
  role: AppRole;
  status: UserStatus;
  isDiaspora: boolean;
  followerCount: number;
  followingCount: number;
  streakMonths: number;
  streakBrokenAt: string | null;
  currentBadgeId: string | null;
  currentTitleId: string | null;
  heritageScore: number;
  regionsVisited: string[];
  sitesVisitedCount: number;
  hasCompletedFirstPurchase: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GuideDoc {
  userId: string;
  bio: string;
  languages: string[];
  specialties: string[];
  toursCompleted: number;
  rating: number | null;
  pricePerDayEtb: number;
  attractionIds: string[];
  region: string;
  verified: boolean;
  respondsIn: string;
  active: boolean;
  photoUrl: string | null;
  displayName: string;
}

export interface GatekeeperDoc {
  userId: string;
  attractionIds: string[];
  active: boolean;
  displayName: string;
  email: string;
  phone: string;
  deviceIds: string[];
}

export interface AdminDoc {
  id: string;
  email: string;
  displayName: string;
  phone: string | null;
  avatarUrl: string | null;
  role: AdminRole;
  attractionId: string | null;
  passwordHash: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AttractionDoc {
  id: string;
  name: string;
  amharicName: string | null;
  address: string;
  region: string;
  category: AttractionCategory;
  description: string;
  summary: string;
  lat: number;
  lng: number;
  ticketPrice: number;
  active: boolean;
  isUnesco: boolean;
  openHours: string;
  tags: string[];
  coverImageUrl: string | null;
  rating: number;
  reviewCount: number;
  enrichedFacts: string[];
  enrichmentStatus: 'none' | 'pending' | 'ready' | 'failed';
  createdAt: string;
  updatedAt: string;
}

export interface HotelDoc {
  id: string;
  name: string;
  region: string;
  nearAttractionId: string;
  pricePerNightEtb: number;
  rating: number;
  reviewCount: number;
  lat: number;
  lng: number;
  amenities: string[];
  freeCancellation: boolean;
  active: boolean;
  coverImageUrl: string | null;
}

export interface TicketDoc {
  id: string;
  code: string;
  qrPayload: string | null;
  attractionId: string;
  holderUserId: string | null;
  holderName: string;
  guests: number;
  visitDate: string;
  purchaserUserId: string;
  purchaserName: string;
  amount: number;
  status: TicketStatus;
  giftId: string | null;
  transactionId: string;
  purchasedAt: string | null;
  usedAt: string | null;
  expiresAt: string | null;
  voidReason: string | null;
}

export interface GiftDoc {
  id: string;
  keycode: string | null;
  attractionId: string;
  senderUserId: string;
  senderName: string;
  recipientNames: string[];
  greeting: string | null;
  visitDate: string | null;
  recipientsTotal: number;
  redeemedCount: number;
  status: GiftStatus;
  transactionId: string;
  createdAt: string;
  expiresAt: string | null;
  revokeReason: string | null;
}

export interface TransactionDoc {
  id: string;
  reference: string;
  kind: TransactionKind;
  status: TransactionStatus;
  payerUserId: string;
  payerName: string;
  attractionId: string | null;
  guideId: string | null;
  hotelId: string | null;
  bookingId: string | null;
  amount: number;
  fee: number;
  commission: number;
  commissionRate: number;
  /** Checkout URL (Telebirr H5 paygate, or mock) */
  checkoutUrl: string | null;
  /** @deprecated alias of checkoutUrl for older clients */
  chapaCheckoutUrl: string | null;
  paymentProvider: 'telebirr' | 'mock';
  failureReason: string | null;
  metadata: Record<string, unknown>;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VisitDoc {
  id: string;
  userId: string | null;
  visitorName: string;
  attractionId: string;
  region: string;
  ticketId: string | null;
  giftId: string | null;
  wasGift: boolean;
  scannedByUserId: string;
  scannedAt: string;
}

export interface BookingDoc {
  id: string;
  guideId: string;
  travelerId: string;
  requestedDate: string;
  note: string | null;
  status: BookingStatus;
  transactionId: string | null;
  amount: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface HotelBookingDoc {
  id: string;
  hotelId: string;
  travelerId: string;
  checkIn: string;
  checkOut: string;
  rooms: number;
  guests: number;
  status: 'requested' | 'confirmed' | 'cancelled';
  transactionId: string | null;
  amount: number | null;
  createdAt: string;
}

export interface RecapDoc {
  id: string;
  authorId: string;
  attractionId: string;
  visitId: string | null;
  body: string;
  media: Array<{ url: string; kind: 'image' | 'video'; name?: string }>;
  imageUrl: string | null;
  audioUrl: string | null;
  aiAssisted: boolean;
  hasVoiceStory: boolean;
  isGiftedVisit: boolean;
  status: RecapStatus;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  reportCount: number;
  reportReasons: string[];
  removalReason: string | null;
  visitedOn: string;
  createdAt: string;
}

export interface AuthUser {
  kind: 'app';
  userId: string;
  firebaseUid: string;
  role: AppRole;
  attractionIds: string[];
}

export interface AuthAdmin {
  kind: 'admin';
  adminId: string;
  role: AdminRole;
  attractionId: string | null;
  email: string;
}

export type AuthPrincipal = AuthUser | AuthAdmin;
