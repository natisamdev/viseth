import bcrypt from 'bcryptjs';
import { env } from '../config/env';
import { initFirebase, db } from '../config/firebase';
import { DEFAULT_FLAGS, DEFAULT_SETTINGS } from '../services/settings';
import {
  DEFAULT_FOLLOWER_TITLES,
  DEFAULT_STREAK_TIERS,
} from '../services/gamification';
import { nowIso } from '../utils/time';
import type {
  AdminDoc,
  AttractionDoc,
  GatekeeperDoc,
  GuideDoc,
  HotelDoc,
  RecapDoc,
  UserDoc,
} from '../types';

async function wipeCollection(name: string) {
  const snap = await db().collection(name).limit(400).get();
  if (snap.empty) return;
  const batch = db().batch();
  for (const doc of snap.docs) batch.delete(doc.ref);
  await batch.commit();
  if (snap.size === 400) await wipeCollection(name);
}

async function seed() {
  initFirebase();
  console.log('Seeding Viseth Firestore…');

  const collections = [
    'platform_settings',
    'feature_flags',
    'gamification',
    'admins',
    'attractions',
    'hotels',
    'users',
    'guides',
    'gatekeepers',
    'recap_posts',
    'social_reports',
    'support_cases',
    'announcements',
    'payouts',
  ];
  for (const c of collections) {
    await wipeCollection(c);
  }

  await db().collection('platform_settings').doc('default').set(DEFAULT_SETTINGS);
  await db().collection('feature_flags').doc('default').set(DEFAULT_FLAGS);
  await db().collection('gamification').doc('streak_tiers').set({ tiers: DEFAULT_STREAK_TIERS });
  await db()
    .collection('gamification')
    .doc('follower_titles')
    .set({ titles: DEFAULT_FOLLOWER_TITLES });

  const now = nowIso();

  const superAdmin: AdminDoc = {
    id: 'au_super_01',
    email: 'superadmin@viseth.et',
    displayName: 'Selamawit Kebede',
    phone: '+251911000001',
    avatarUrl: null,
    role: 'super_admin',
    attractionId: null,
    passwordHash: await bcrypt.hash(env.seedAdminPassword, 10),
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  await db().collection('admins').doc(superAdmin.id).set(superAdmin);

  const attractions: AttractionDoc[] = [
    {
      id: 'atr_adwa',
      name: 'Adwa Victory Memorial Museum',
      amharicName: 'የአድዋ ድል መታሰቢያ ሙዚየም',
      address: 'Piassa Square, Addis Ababa',
      region: 'Addis Ababa',
      category: 'museum',
      summary:
        'A monument and museum to the 1896 victory at Adwa, where Ethiopian forces defeated a colonial invasion.',
      description:
        'The Adwa Victory Memorial Museum commemorates the Battle of Adwa and Ethiopia’s independence.',
      lat: 9.0342,
      lng: 38.7636,
      ticketPrice: 300,
      active: true,
      isUnesco: false,
      openHours: '09:00–17:00',
      tags: ['history', 'family'],
      coverImageUrl: null,
      rating: 4.8,
      reviewCount: 214,
      enrichedFacts: [
        'The Battle of Adwa was fought on 1 March 1896.',
        'Ethiopia remained independent after defeating a European colonial army.',
        'The memorial complex includes exhibition halls and a theatre.',
      ],
      enrichmentStatus: 'ready',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'atr_lalibela',
      name: 'Lalibela Rock-Hewn Churches',
      amharicName: 'ላሊበላ የተቆረጡ አብያተ ክርስቲያናት',
      address: 'Lalibela, Amhara',
      region: 'Amhara',
      category: 'heritage',
      summary: 'Eleven medieval churches carved from living rock — a UNESCO World Heritage Site.',
      description:
        'King Lalibela’s New Jerusalem: interconnected rock-hewn churches still used for worship.',
      lat: 12.031,
      lng: 39.047,
      ticketPrice: 1000,
      active: true,
      isUnesco: true,
      openHours: '06:00–18:00',
      tags: ['unesco', 'faith'],
      coverImageUrl: null,
      rating: 4.9,
      reviewCount: 1820,
      enrichedFacts: [
        'Carved in the 12th–13th centuries.',
        'Still an active pilgrimage site.',
        'Bete Giyorgis is the most iconic cross-shaped church.',
      ],
      enrichmentStatus: 'ready',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'atr_harar',
      name: 'Harar Jugol',
      amharicName: 'የሐረር ጁጎል',
      address: 'Harar, Harari',
      region: 'Harari',
      category: 'heritage',
      summary: 'The walled city of Harar — one of Islam’s holiest cities and a UNESCO site.',
      description: 'Narrow alleys, colorful markets, and hyena feeding traditions.',
      lat: 9.3125,
      lng: 42.1225,
      ticketPrice: 250,
      active: true,
      isUnesco: true,
      openHours: '08:00–18:00',
      tags: ['unesco', 'culture'],
      coverImageUrl: null,
      rating: 4.7,
      reviewCount: 640,
      enrichedFacts: [
        'Harar Jugol has 82 mosques and over 100 shrines.',
        'The old wall has five historic gates.',
        'Famous for evening hyena feeding.',
      ],
      enrichmentStatus: 'ready',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'atr_gondar',
      name: 'Fasil Ghebbi (Gondar)',
      amharicName: 'ፋሲል ግቢ',
      address: 'Gondar, Amhara',
      region: 'Amhara',
      category: 'heritage',
      summary: 'Royal enclosure of castles from Ethiopia’s camelot era.',
      description: '17th-century castles of Emperor Fasilides and successors.',
      lat: 12.608,
      lng: 37.466,
      ticketPrice: 400,
      active: true,
      isUnesco: true,
      openHours: '08:30–17:30',
      tags: ['unesco', 'history'],
      coverImageUrl: null,
      rating: 4.8,
      reviewCount: 990,
      enrichedFacts: [
        'Capital of Ethiopia from the 1630s.',
        'UNESCO World Heritage Site since 1979.',
      ],
      enrichmentStatus: 'ready',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'atr_aksum',
      name: 'Aksum Obelisks',
      amharicName: 'የአክሱም ሐውልቶች',
      address: 'Aksum, Tigray',
      region: 'Tigray',
      category: 'heritage',
      summary: 'Stelae field of the ancient Aksumite kingdom.',
      description: 'Monumental granite stelae marking royal tombs of ancient Aksum.',
      lat: 14.132,
      lng: 38.72,
      ticketPrice: 350,
      active: true,
      isUnesco: true,
      openHours: '08:00–17:00',
      tags: ['unesco', 'ancient'],
      coverImageUrl: null,
      rating: 4.8,
      reviewCount: 720,
      enrichedFacts: [
        'Aksum was a major trading empire.',
        'Home of the Church of St Mary of Zion traditions.',
      ],
      enrichmentStatus: 'ready',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'atr_sofomar',
      name: 'Sof Omar Cave',
      amharicName: 'ሶፍ ኦማር ዋሻ',
      address: 'Bale Zone, Oromia',
      region: 'Oromia',
      category: 'natural',
      summary: 'One of Africa’s most spectacular limestone cave systems.',
      description: 'Sacred Islamic pilgrimage site and geological wonder.',
      lat: 6.9,
      lng: 40.85,
      ticketPrice: 200,
      active: true,
      isUnesco: false,
      openHours: '08:00–17:00',
      tags: ['cave', 'nature'],
      coverImageUrl: null,
      rating: 4.6,
      reviewCount: 310,
      enrichedFacts: [
        'Over 15 km of mapped passages.',
        'Named after Sheikh Sof Omar.',
      ],
      enrichmentStatus: 'ready',
      createdAt: now,
      updatedAt: now,
    },
  ];

  for (const a of attractions) {
    await db().collection('attractions').doc(a.id).set(a);
  }

  const placeAdmin: AdminDoc = {
    id: 'au_place_harar',
    email: 'harar.admin@viseth.et',
    displayName: 'Place Admin Harar',
    phone: '+251911000002',
    avatarUrl: null,
    role: 'place_admin',
    attractionId: 'atr_harar',
    passwordHash: await bcrypt.hash(env.seedAdminPassword, 10),
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  await db().collection('admins').doc(placeAdmin.id).set(placeAdmin);

  const hotels: HotelDoc[] = [
    {
      id: 'htl_piassa',
      name: 'Piassa Heritage Inn',
      region: 'Addis Ababa',
      nearAttractionId: 'atr_adwa',
      pricePerNightEtb: 1800,
      rating: 4.5,
      reviewCount: 88,
      lat: 9.033,
      lng: 38.75,
      amenities: ['wifi', 'breakfast'],
      freeCancellation: true,
      active: true,
      coverImageUrl: null,
    },
    {
      id: 'htl_lalibela',
      name: 'Mountain View Lalibela',
      region: 'Amhara',
      nearAttractionId: 'atr_lalibela',
      pricePerNightEtb: 2200,
      rating: 4.7,
      reviewCount: 140,
      lat: 12.04,
      lng: 39.04,
      amenities: ['wifi', 'guide desk'],
      freeCancellation: true,
      active: true,
      coverImageUrl: null,
    },
    {
      id: 'htl_harar',
      name: 'Jugol Courtyard Hotel',
      region: 'Harari',
      nearAttractionId: 'atr_harar',
      pricePerNightEtb: 1500,
      rating: 4.4,
      reviewCount: 62,
      lat: 9.31,
      lng: 42.125,
      amenities: ['wifi', 'courtyard'],
      freeCancellation: false,
      active: true,
      coverImageUrl: null,
    },
  ];
  for (const h of hotels) await db().collection('hotels').doc(h.id).set(h);

  const guideUser: UserDoc = {
    id: 'usr_guide_01',
    firebaseUid: 'seed_guide_firebase_uid',
    email: 'guide.hana@viseth.et',
    phone: '+251911000010',
    displayName: 'Hana Bekele',
    username: 'hanab',
    photoUrl: null,
    bio: 'Rock churches, highland trails, long coffee ceremonies.',
    region: 'Amhara',
    role: 'guide',
    status: 'active',
    isDiaspora: false,
    followerCount: 2840,
    followingCount: 240,
    streakMonths: 12,
    streakBrokenAt: null,
    currentBadgeId: 'tier_shotel',
    currentTitleId: 'ttl_vanguard',
    heritageScore: 78,
    regionsVisited: ['Amhara', 'Tigray', 'Addis Ababa', 'Harari', 'Oromia'],
    sitesVisitedCount: 19,
    hasCompletedFirstPurchase: true,
    createdAt: now,
    updatedAt: now,
  };
  await db().collection('users').doc(guideUser.id).set(guideUser);

  const guide: GuideDoc = {
    userId: guideUser.id,
    bio: guideUser.bio,
    languages: ['am', 'en'],
    specialties: ['Lalibela', 'Gondar', 'faith tourism'],
    toursCompleted: 126,
    rating: 4.9,
    pricePerDayEtb: 2500,
    attractionIds: ['atr_lalibela', 'atr_gondar'],
    region: 'Amhara',
    verified: true,
    respondsIn: 'under 2 hours',
    active: true,
    photoUrl: null,
    displayName: guideUser.displayName,
  };
  await db().collection('guides').doc(guide.userId).set(guide);

  const gateUser: UserDoc = {
    id: 'usr_gate_harar',
    firebaseUid: 'seed_gate_firebase_uid',
    email: 'gate.harar@viseth.et',
    phone: '+251911000011',
    displayName: 'Gatekeeper Harar',
    username: 'gateharar',
    photoUrl: null,
    bio: '',
    region: 'Harari',
    role: 'gatekeeper',
    status: 'active',
    isDiaspora: false,
    followerCount: 0,
    followingCount: 0,
    streakMonths: 0,
    streakBrokenAt: null,
    currentBadgeId: null,
    currentTitleId: 'ttl_traveler',
    heritageScore: 0,
    regionsVisited: [],
    sitesVisitedCount: 0,
    hasCompletedFirstPurchase: false,
    createdAt: now,
    updatedAt: now,
  };
  await db().collection('users').doc(gateUser.id).set(gateUser);

  const gatekeeper: GatekeeperDoc = {
    userId: gateUser.id,
    attractionIds: ['atr_harar'],
    active: true,
    displayName: gateUser.displayName,
    email: gateUser.email!,
    phone: gateUser.phone!,
    deviceIds: [],
  };
  await db().collection('gatekeepers').doc(gatekeeper.userId).set(gatekeeper);

  const traveler: UserDoc = {
    id: 'usr_seed_traveler',
    firebaseUid: 'seed_traveler_firebase_uid',
    email: 'selam@example.com',
    phone: '+251911000000',
    displayName: 'Selam Tesfaye',
    username: 'selam',
    photoUrl: null,
    bio: 'Collecting verified stamps.',
    region: 'Addis Ababa',
    role: 'traveler',
    status: 'active',
    isDiaspora: false,
    followerCount: 12,
    followingCount: 4,
    streakMonths: 2,
    streakBrokenAt: null,
    currentBadgeId: 'tier_dula',
    currentTitleId: 'ttl_traveler',
    heritageScore: 33,
    regionsVisited: ['Addis Ababa', 'Amhara'],
    sitesVisitedCount: 2,
    hasCompletedFirstPurchase: true,
    createdAt: now,
    updatedAt: now,
  };
  await db().collection('users').doc(traveler.id).set(traveler);

  const recap: RecapDoc = {
    id: 'pst_seed_01',
    authorId: guideUser.id,
    attractionId: 'atr_lalibela',
    visitId: null,
    body: 'The rock churches feel eternal at sunrise.',
    media: [],
    imageUrl: null,
    audioUrl: null,
    aiAssisted: true,
    hasVoiceStory: true,
    isGiftedVisit: false,
    status: 'published',
    likeCount: 42,
    commentCount: 3,
    shareCount: 8,
    reportCount: 0,
    reportReasons: [],
    removalReason: null,
    visitedOn: '2026-07-20',
    createdAt: now,
  };
  const flagged: RecapDoc = {
    ...recap,
    id: 'pst_seed_flagged',
    body: 'Flagged sample content for moderation demo.',
    status: 'flagged',
    reportCount: 3,
    reportReasons: ['other', 'other', 'other'],
    likeCount: 1,
  };
  await db().collection('recap_posts').doc(recap.id).set(recap);
  await db().collection('recap_posts').doc(flagged.id).set(flagged);

  for (const [rid, category] of [
    ['rpt_01', 'violence'],
    ['rpt_02', 'sexual_abuse'],
    ['rpt_03', 'other'],
  ] as const) {
    await db()
      .collection('social_reports')
      .doc(rid)
      .set({
        id: rid,
        category,
        contentType: 'recap',
        status: 'open',
        reporterUserId: traveler.id,
        reportedUserId: guideUser.id,
        targetId: flagged.id,
        postId: flagged.id,
        contentPreview: flagged.body,
        notes: 'Demo report',
        resolutionNote: null,
        resolvedByAdminId: null,
        createdAt: now,
        resolvedAt: null,
      });
  }

  await db().collection('support_cases').doc('sup_01').set({
    id: 'sup_01',
    kind: 'payment',
    status: 'open',
    subject: 'Ticket paid but not issued',
    createdAt: now,
  });

  await db().collection('announcements').doc('ann_01').set({
    id: 'ann_01',
    title: 'Welcome to Viseth',
    body: 'Verified heritage visits across Ethiopia.',
    audience: 'all',
    createdAt: now,
  });

  console.log('Seed complete.');
  console.log('');
  console.log('Super Admin login:');
  console.log('  email:    superadmin@viseth.et');
  console.log(`  password: ${env.seedAdminPassword}`);
  console.log('Place Admin (Harar):');
  console.log('  email:    harar.admin@viseth.et');
  console.log(`  password: ${env.seedAdminPassword}`);
  console.log('');
  console.log('Note: Seed app users use placeholder firebaseUid values.');
  console.log('Real Flutter logins upsert users via GET /v1/me.');
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
