/**
 * Seed the AKODD database with the same demo data the mobile AppContext used to ship from AsyncStorage.
 * Idempotent: uses ON CONFLICT DO NOTHING so re-runs are safe.
 *
 * Run with:  pnpm --filter @workspace/scripts run seed-db
 */
import {
  db,
  categoriesTable,
  usersTable,
  businessesTable,
  businessEmployeesTable,
  servicesTable,
  serviceOptionsTable,
  serviceReviewsTable,
  bizAccountsTable,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import bcrypt from "bcryptjs";

const BCRYPT_COST = 10;

// Demo users — admin, customer, and SP owners referenced by businesses/biz_accounts.
// Customer/admin are passwordless on the mobile UX (admin uses PIN, customer uses
// frictionless email+name); SP owners' real auth happens against biz_accounts.passwordHash.
const SEED_USERS = [
  // u1 was reserved by an earlier Stripe demo row; use u_admin instead.
  { id: "u_admin", name: "Admin",      email: "admin@akodd.com",            role: "admin" as const },
  { id: "u_demo_customer", name: "Demo Customer", email: "demo@akodd.com",  role: "customer" as const },
  { id: "u2",  name: "Jessica Lee",    email: "hello@sparkcleanpro.com",    role: "business" as const, businessId: "b1" },
  { id: "u3",  name: "Owner of b2",    email: "owner@sturdipost.com",       role: "business" as const, businessId: "b2" },
  { id: "u4",  name: "Owner of b3",    email: "owner@greenthumb.com",       role: "business" as const, businessId: "b3" },
  { id: "u5",  name: "Nadia Thorn",    email: "hello@arcticroots.com",      role: "business" as const, businessId: "b4" },
  { id: "u6",  name: "Owner of b5",    email: "owner@colorcraft.com",       role: "business" as const, businessId: "b5" },
  { id: "u7",  name: "Owner of b6",    email: "owner@swiftmove.com",        role: "business" as const, businessId: "b6" },
  { id: "u9",  name: "Marcus Hale",    email: "hello@skyshieldroofing.com", role: "business" as const, businessId: "b8" },
  { id: "u10", name: "Owner of b9",    email: "owner@flowclear.com",        role: "business" as const, businessId: "b9" },
  { id: "u11", name: "Owner of b10",   email: "owner@icebuster.com",        role: "business" as const, businessId: "b10" },
  { id: "u12", name: "Owner of b11",   email: "owner@quicklube.com",        role: "business" as const, businessId: "b11" },
  { id: "u13", name: "Owner of b12",   email: "owner@happypaws.com",        role: "business" as const, businessId: "b12" },
  { id: "u14", name: "Owner of b13",   email: "owner@vaultpark.com",        role: "business" as const, businessId: "b13" },
  { id: "u15", name: "Owner of b14",   email: "owner@dashdrop.com",         role: "business" as const, businessId: "b14" },
];

const SEED_CATEGORIES = [
  { id: "gifts", name: "Gift Services", icon: "gift", color: "#E91E63", serviceCount: 0, active: true },
  { id: "cleaning", name: "Cleaning", icon: "wind", color: "#4FC3F7", serviceCount: 24, active: true },
  { id: "landscaping", name: "Landscaping", icon: "sun", color: "#66BB6A", serviceCount: 20, active: true },
  { id: "handyman", name: "Handyman", icon: "tool", color: "#78909C", serviceCount: 31, active: true },
  { id: "electrical", name: "Electrical Service", icon: "zap", color: "#FBC02D", serviceCount: 0, active: true },
  { id: "beauty", name: "Beauty", icon: "scissors", color: "#F48FB1", serviceCount: 17, active: true },
  { id: "petwalk", name: "Pet Walking", icon: "heart", color: "#EC407A", serviceCount: 22, active: true },
  { id: "oilchange", name: "Auto Oil Change", icon: "settings", color: "#FF7043", serviceCount: 13, active: true },
  { id: "courier", name: "Courier", icon: "package", color: "#29B6F6", serviceCount: 18, active: true },
  { id: "moving", name: "Moving", icon: "truck", color: "#FF8A65", serviceCount: 9, active: true },
  { id: "painting", name: "Painting", icon: "pen-tool", color: "#BA68C8", serviceCount: 12, active: true },
  { id: "fence", name: "Fence Repair", icon: "shield", color: "#8D6E63", serviceCount: 11, active: true },
  { id: "roof", name: "Roof Repair", icon: "home", color: "#5C6BC0", serviceCount: 8, active: true },
  { id: "gutters", name: "Gutters", icon: "git-branch", color: "#26A69A", serviceCount: 7, active: true },
  { id: "snow", name: "Snow Removal", icon: "cloud-snow", color: "#42A5F5", serviceCount: 10, active: true },
  { id: "carstorage", name: "Car Storage", icon: "archive", color: "#8D6E63", serviceCount: 5, active: true },
  { id: "nails", name: "Nails", icon: "smile", color: "#F06292", serviceCount: 0, active: true },
  { id: "pedicure", name: "Pedicure", icon: "droplet", color: "#26C6DA", serviceCount: 0, active: true },
  { id: "acupuncture", name: "Acupuncture", icon: "git-commit", color: "#EF5350", serviceCount: 0, active: true },
  { id: "reiki", name: "Reiki", icon: "sunrise", color: "#9575CD", serviceCount: 0, active: true },
  { id: "massage", name: "Massage", icon: "thumbs-up", color: "#FFA726", serviceCount: 0, active: true },
  { id: "ikea-assembly", name: "IKEA Assembly", icon: "layers", color: "#7E57C2", serviceCount: 0, active: true },
  { id: "tv-mounting", name: "TV Mounting", icon: "tv", color: "#00ACC1", serviceCount: 0, active: true },
];

const SEED_BUSINESSES = [
  { id: "b1", ownerId: "u2", name: "SparkClean Pro", description: "Premium residential and commercial cleaning with eco-friendly products.", categoryId: "cleaning", rating: "4.90", reviewCount: 128, subscriptionActive: true, subscriptionPlan: "pro_business" as const, phone: "+1 555-0101", location: "Downtown", joinedDate: "2023-01-15", serviceCount: 5, employees: [] as { specialty?: string }[] },
  { id: "b2", ownerId: "u3", name: "SturdiPost Fencing", description: "Expert fence installation, repair, and replacement for all fence types.", categoryId: "fence", rating: "4.70", reviewCount: 52, subscriptionActive: true, subscriptionPlan: "starter_gigger" as const, phone: "+1 555-0102", location: "Midtown", joinedDate: "2023-05-10", serviceCount: 4, employees: [] },
  { id: "b3", ownerId: "u4", name: "GreenThumb Gardens", description: "Transform your outdoor space with expert landscaping design and maintenance.", categoryId: "landscaping", rating: "4.80", reviewCount: 74, subscriptionActive: true, subscriptionPlan: "starter_gigger" as const, phone: "+1 555-0103", location: "Eastside", joinedDate: "2023-03-10", serviceCount: 6, employees: [] },
  { id: "b4", ownerId: "u5", name: "Arctic Roots Landscaping", description: "Full-service landscaping for Alaska's unique climate — design, planting, and seasonal yard care.", categoryId: "landscaping", rating: "4.70", reviewCount: 38, subscriptionActive: true, subscriptionPlan: "pro_business" as const, phone: "+1 555-0104", location: "Southside", joinedDate: "2023-09-12", serviceCount: 3, employees: [{ specialty: "Garden Design" }, { specialty: "Landscape Design" }, { specialty: "Seasonal Planting" }, {}] },
  { id: "b5", ownerId: "u6", name: "ColorCraft Painting", description: "Interior and exterior painting specialists.", categoryId: "painting", rating: "4.90", reviewCount: 41, subscriptionActive: true, subscriptionPlan: "starter_gigger" as const, phone: "+1 555-0105", location: "Northside", joinedDate: "2023-06-01", serviceCount: 4, employees: [] },
  { id: "b6", ownerId: "u7", name: "SwiftMove Co.", description: "Efficient, careful movers for local and long-distance relocations.", categoryId: "moving", rating: "4.50", reviewCount: 63, subscriptionActive: true, subscriptionPlan: "pro_business" as const, phone: "+1 555-0106", location: "Downtown", joinedDate: "2023-02-14", serviceCount: 3, employees: [] },
  { id: "b8", ownerId: "u9", name: "SkyShield Roofing", description: "Licensed roofing contractors specializing in leak detection and repair.", categoryId: "roof", rating: "4.70", reviewCount: 39, subscriptionActive: true, subscriptionPlan: "pro_business" as const, phone: "+1 555-0108", location: "Metro area", joinedDate: "2022-09-15", serviceCount: 6, employees: [] },
  { id: "b9", ownerId: "u10", name: "FlowClear Gutters", description: "Gutter cleaning, repair, and guard installation.", categoryId: "gutters", rating: "4.80", reviewCount: 47, subscriptionActive: true, subscriptionPlan: "starter_gigger" as const, phone: "+1 555-0109", location: "Suburbs", joinedDate: "2023-07-20", serviceCount: 3, employees: [] },
  { id: "b10", ownerId: "u11", name: "IceBuster Snow Co.", description: "Residential and commercial snow plowing and ice treatment.", categoryId: "snow", rating: "4.60", reviewCount: 58, subscriptionActive: true, subscriptionPlan: "pro_business" as const, phone: "+1 555-0110", location: "North District", joinedDate: "2022-12-01", serviceCount: 4, employees: [] },
  { id: "b11", ownerId: "u12", name: "QuickLube Mobile", description: "Mobile oil changes done in your driveway.", categoryId: "oilchange", rating: "4.80", reviewCount: 112, subscriptionActive: true, subscriptionPlan: "pro_business" as const, phone: "+1 555-0111", location: "Citywide", joinedDate: "2023-01-10", serviceCount: 4, employees: [] },
  { id: "b12", ownerId: "u13", name: "Happy Paws Walking", description: "Insured, GPS-tracked dog walking and pet care services.", categoryId: "petwalk", rating: "5.00", reviewCount: 144, subscriptionActive: true, subscriptionPlan: "pro_business" as const, phone: "+1 555-0112", location: "Eastside", joinedDate: "2022-10-05", serviceCount: 5, employees: [] },
  { id: "b13", ownerId: "u14", name: "VaultPark Storage", description: "Indoor climate-controlled vehicle storage.", categoryId: "carstorage", rating: "4.70", reviewCount: 28, subscriptionActive: true, subscriptionPlan: "starter_gigger" as const, phone: "+1 555-0113", location: "Industrial Zone", joinedDate: "2023-08-01", serviceCount: 3, employees: [] },
  { id: "b14", ownerId: "u15", name: "DashDrop Courier", description: "Same-day and scheduled parcel delivery across the city.", categoryId: "courier", rating: "4.60", reviewCount: 73, subscriptionActive: true, subscriptionPlan: "pro_business" as const, phone: "+1 555-0114", location: "Citywide", joinedDate: "2023-03-18", serviceCount: 4, employees: [] },
];

interface SeedOption { id: string; name: string; description: string; price: string; duration: string; }
interface SeedReview { id: string; authorName: string; rating: number; comment: string; date: string; }
interface SeedService {
  id: string; businessId: string; businessName: string; categoryId: string;
  title: string; description: string; rating: string; reviewCount: number;
  startingPrice: string; tags: string[]; featured: boolean;
  requiredSpecialty?: string; options: SeedOption[]; reviews: SeedReview[];
}

const SEED_SERVICES: SeedService[] = [
  { id: "s1", businessId: "b1", businessName: "SparkClean Pro", categoryId: "cleaning", title: "Deep Home Cleaning", description: "Full deep clean of your entire home.", rating: "4.90", reviewCount: 128, startingPrice: "149", featured: true, tags: ["eco-friendly", "same-day", "insured"], options: [{ id: "o1", name: "1-2 Bedroom", description: "Up to 1,200 sq ft", price: "149", duration: "3 hrs" }, { id: "o2", name: "3-4 Bedroom", description: "Up to 2,200 sq ft", price: "219", duration: "5 hrs" }, { id: "o3", name: "5+ Bedroom", description: "Over 2,200 sq ft", price: "299", duration: "7 hrs" }], reviews: [{ id: "r1", authorName: "Sarah M.", rating: 5, comment: "Absolutely spotless!", date: "2 days ago" }] },
  { id: "s2", businessId: "b1", businessName: "SparkClean Pro", categoryId: "cleaning", title: "Regular Weekly Cleaning", description: "Recurring weekly maintenance cleaning.", rating: "4.80", reviewCount: 56, startingPrice: "89", featured: false, tags: ["recurring", "eco-friendly"], options: [{ id: "o4", name: "Small Home", description: "Up to 1,000 sq ft", price: "89", duration: "2 hrs" }, { id: "o5", name: "Medium Home", description: "Up to 1,800 sq ft", price: "119", duration: "3 hrs" }], reviews: [{ id: "r3", authorName: "Linda R.", rating: 5, comment: "Never miss a spot.", date: "3 days ago" }] },
  { id: "s3", businessId: "b2", businessName: "SturdiPost Fencing", categoryId: "fence", title: "Fence Panel Repair", description: "Professional repair of damaged fence panels.", rating: "4.70", reviewCount: 52, startingPrice: "99", featured: true, tags: ["insured", "licensed", "fast"], options: [{ id: "o6", name: "1-3 Panels", description: "Small section repair", price: "99", duration: "2 hrs" }, { id: "o7", name: "4-8 Panels", description: "Mid-section repair", price: "199", duration: "4 hrs" }, { id: "o8", name: "Full Side Replacement", description: "One full fence side", price: "449", duration: "Full day" }], reviews: [{ id: "r4", authorName: "Greg H.", rating: 5, comment: "Fixed my fence in hours.", date: "1 week ago" }] },
  { id: "s4", businessId: "b3", businessName: "GreenThumb Gardens", categoryId: "landscaping", title: "Lawn Mowing & Edging", description: "Professional lawn mow, edge trimming, and debris removal.", rating: "4.80", reviewCount: 74, startingPrice: "55", featured: true, tags: ["eco", "weekly", "insured"], options: [{ id: "o9", name: "Small Yard", description: "Up to 2,000 sq ft", price: "55", duration: "1 hr" }, { id: "o10", name: "Medium Yard", description: "Up to 5,000 sq ft", price: "85", duration: "2 hrs" }, { id: "o11", name: "Large Yard", description: "Over 5,000 sq ft", price: "129", duration: "3 hrs" }], reviews: [{ id: "r5", authorName: "David L.", rating: 5, comment: "Best lawn service around.", date: "1 week ago" }] },
  { id: "s4b", businessId: "b4", businessName: "Arctic Roots Landscaping", categoryId: "landscaping", title: "Garden Design & Planting", description: "Custom garden layout and planting tailored to Alaska's short growing season.", rating: "4.70", reviewCount: 38, startingPrice: "149", featured: true, tags: ["alaska-native-plants", "insured", "seasonal"], requiredSpecialty: "Garden Design", options: [{ id: "ob1", name: "Consultation + Plan", description: "Design plan only", price: "149", duration: "2 hrs" }, { id: "ob2", name: "Small Garden Install", description: "Up to 200 sq ft planting", price: "349", duration: "Half day" }, { id: "ob3", name: "Full Garden Build", description: "Design + full planting", price: "749", duration: "Full day" }], reviews: [{ id: "rb1", authorName: "Karen T.", rating: 5, comment: "Beautiful garden, perfect for our Alaska weather.", date: "2 weeks ago" }] },
  { id: "s4c", businessId: "b4", businessName: "Arctic Roots Landscaping", categoryId: "landscaping", title: "Spring Yard Cleanup", description: "Full yard cleanup after winter — debris removal, raking, bed prep, and fertilising.", rating: "4.60", reviewCount: 22, startingPrice: "89", featured: false, tags: ["seasonal", "eco-friendly", "fast"], options: [{ id: "ob4", name: "Small Yard", description: "Up to 2,500 sq ft", price: "89", duration: "2 hrs" }, { id: "ob5", name: "Large Yard", description: "Up to 6,000 sq ft", price: "179", duration: "4 hrs" }], reviews: [{ id: "rb2", authorName: "Mike S.", rating: 5, comment: "Had my yard ready for summer in no time.", date: "1 month ago" }] },
  { id: "s6", businessId: "b5", businessName: "ColorCraft Painting", categoryId: "painting", title: "Interior Room Painting", description: "Transform a room with premium paint. We prep, prime, paint, and clean up.", rating: "4.90", reviewCount: 41, startingPrice: "199", featured: true, tags: ["premium paint", "insured", "warranty"], options: [{ id: "o14", name: "Single Room", description: "One room, 2 coats", price: "199", duration: "1 day" }, { id: "o15", name: "2-3 Rooms", description: "Two or three rooms", price: "479", duration: "2 days" }, { id: "o16", name: "Full Interior", description: "Whole-house interior", price: "1299", duration: "5 days" }], reviews: [{ id: "r7", authorName: "Amy C.", rating: 5, comment: "Flawless finish.", date: "3 weeks ago" }] },
  { id: "s7", businessId: "b6", businessName: "SwiftMove Co.", categoryId: "moving", title: "Local Home Moving", description: "Full local move: packing, loading, transport, and unloading.", rating: "4.50", reviewCount: 63, startingPrice: "299", featured: false, tags: ["insured", "careful", "same-week"], options: [{ id: "o17", name: "Studio/1BR", description: "Up to 1 bedroom", price: "299", duration: "4 hrs" }, { id: "o18", name: "2-3 Bedroom", description: "Family home move", price: "549", duration: "8 hrs" }, { id: "o19", name: "Large Home", description: "4+ bedroom home", price: "899", duration: "Full day" }], reviews: [{ id: "r8", authorName: "Robert T.", rating: 5, comment: "Not a single item scratched.", date: "1 month ago" }] },
  { id: "s9", businessId: "b8", businessName: "SkyShield Roofing", categoryId: "roof", title: "Roof Leak Repair", description: "Fast diagnosis and repair of roof leaks and missing shingles.", rating: "4.70", reviewCount: 39, startingPrice: "149", featured: false, tags: ["licensed", "insured", "storm damage"], options: [{ id: "o23", name: "Inspection Only", description: "Full roof assessment + report", price: "149", duration: "1.5 hrs" }, { id: "o24", name: "Minor Repair", description: "Patch, flashing, or shingles", price: "349", duration: "Half day" }, { id: "o25", name: "Major Repair", description: "Large section replacement", price: "899", duration: "Full day" }], reviews: [{ id: "r10", authorName: "Frank D.", rating: 5, comment: "Found and fixed two leaks same day.", date: "2 weeks ago" }] },
  { id: "s10", businessId: "b9", businessName: "FlowClear Gutters", categoryId: "gutters", title: "Gutter Cleaning & Flush", description: "Complete gutter cleaning, downspout flushing, and debris removal.", rating: "4.80", reviewCount: 47, startingPrice: "75", featured: false, tags: ["insured", "seasonal", "fast"], options: [{ id: "o26", name: "Single Story", description: "Up to 150 linear ft", price: "75", duration: "1 hr" }, { id: "o27", name: "Two Story", description: "Up to 250 linear ft", price: "129", duration: "2 hrs" }, { id: "o28", name: "Clean + Guards", description: "Cleaning plus guard install", price: "249", duration: "3 hrs" }], reviews: [{ id: "r11", authorName: "Susan H.", rating: 5, comment: "Quick and thorough.", date: "1 week ago" }] },
  { id: "s11", businessId: "b10", businessName: "IceBuster Snow Co.", categoryId: "snow", title: "Driveway & Walkway Snow Removal", description: "Fast residential snow clearing after every snowfall.", rating: "4.60", reviewCount: 58, startingPrice: "49", featured: false, tags: ["24/7", "salting", "seasonal"], options: [{ id: "o29", name: "Single Visit", description: "One-time clearing", price: "49", duration: "30 min" }, { id: "o30", name: "Monthly Pass", description: "All season unlimited visits", price: "199", duration: "Seasonal" }, { id: "o31", name: "Commercial Lot", description: "Parking lot + salting", price: "299", duration: "1.5 hrs" }], reviews: [{ id: "r12", authorName: "Carl M.", rating: 5, comment: "Out at 5am clearing my driveway.", date: "3 weeks ago" }] },
  { id: "s12", businessId: "b11", businessName: "QuickLube Mobile", categoryId: "oilchange", title: "Mobile Oil Change", description: "Full synthetic or conventional oil change in your driveway.", rating: "4.80", reviewCount: 112, startingPrice: "49", featured: true, tags: ["mobile", "fast", "eco disposal"], options: [{ id: "o32", name: "Conventional", description: "5 quarts conventional oil", price: "49", duration: "25 min" }, { id: "o33", name: "Full Synthetic", description: "5 quarts full synthetic", price: "79", duration: "25 min" }, { id: "o34", name: "Synthetic + Inspection", description: "Oil change + 20-pt inspection", price: "109", duration: "45 min" }], reviews: [{ id: "r13", authorName: "Liz K.", rating: 5, comment: "Changed my oil while I worked from home.", date: "5 days ago" }] },
  { id: "s13", businessId: "b12", businessName: "Happy Paws Walking", categoryId: "petwalk", title: "Dog Walking Service", description: "30 or 60-minute GPS-tracked walks with real-time photo updates.", rating: "5.00", reviewCount: 144, startingPrice: "20", featured: true, tags: ["GPS tracked", "insured", "solo walks"], options: [{ id: "o35", name: "30-Minute Walk", description: "Solo walk with photos", price: "20", duration: "30 min" }, { id: "o36", name: "60-Minute Walk", description: "Extended solo walk", price: "35", duration: "60 min" }, { id: "o37", name: "Weekly Bundle (5)", description: "Five 30-min walks", price: "89", duration: "Weekly" }], reviews: [{ id: "r14", authorName: "Jen A.", rating: 5, comment: "My dog loves them!", date: "2 days ago" }] },
  { id: "s14", businessId: "b13", businessName: "VaultPark Storage", categoryId: "carstorage", title: "Indoor Vehicle Storage", description: "Climate-controlled, camera-monitored indoor storage for your vehicle.", rating: "4.70", reviewCount: 28, startingPrice: "99", featured: false, tags: ["climate controlled", "24/7 access", "insured"], options: [{ id: "o38", name: "Motorcycle", description: "Single motorcycle space", price: "99", duration: "Monthly" }, { id: "o39", name: "Standard Vehicle", description: "Car up to 18 ft", price: "159", duration: "Monthly" }, { id: "o40", name: "Large / Classic", description: "Truck, SUV, or classic car", price: "219", duration: "Monthly" }], reviews: [{ id: "r15", authorName: "Dean W.", rating: 5, comment: "Facility is immaculate.", date: "1 month ago" }] },
  { id: "s15", businessId: "b14", businessName: "DashDrop Courier", categoryId: "courier", title: "Same-Day City Delivery", description: "Pick up and deliver packages anywhere in the city, same day.", rating: "4.60", reviewCount: 73, startingPrice: "15", featured: false, tags: ["tracked", "insured", "same-day"], options: [{ id: "o41", name: "Standard (4hr)", description: "Delivery within 4 hours", price: "15", duration: "Up to 4 hrs" }, { id: "o42", name: "Priority (2hr)", description: "Delivery within 2 hours", price: "25", duration: "Up to 2 hrs" }, { id: "o43", name: "Express (1hr)", description: "Rush delivery in 1 hour", price: "45", duration: "Up to 1 hr" }], reviews: [{ id: "r16", authorName: "Nina P.", rating: 5, comment: "Delivered across the city in 90 minutes.", date: "1 week ago" }] },
];

// Plaintext demo passwords — hashed with bcrypt at seed time below.
// Login UX: SP enters this raw password against /auth/business/login.
const SEED_BIZ_ACCOUNTS_PLAINTEXT = [
  { id: "b1", businessName: "SparkClean Pro", ownerName: "Jessica Lee", phone: "+1 907-555-0101", email: "hello@sparkcleanpro.com", password: "sparkclean123", businessType: "home-based" as const, yearsInBusiness: "3", alaskaLicenseNumber: "AK-2021-CL-001", businessDescription: "Premium residential and commercial cleaning with eco-friendly products.", status: "approved" as const, expiresAt: new Date("2030-01-15T00:00:00.000Z"), ownerId: "u2" },
  { id: "b8", businessName: "SkyShield Roofing", ownerName: "Marcus Hale", phone: "+1 907-555-0108", email: "hello@skyshieldroofing.com", password: "skyshield123", businessType: "brick-and-mortar" as const, yearsInBusiness: "8", alaskaLicenseNumber: "AK-2016-RF-008", businessDescription: "Licensed roofing contractors specializing in leak detection and repair.", status: "approved" as const, expiresAt: new Date("2030-09-15T00:00:00.000Z"), ownerId: "u9" },
  { id: "b4", businessName: "Arctic Roots Landscaping", ownerName: "Nadia Thorn", phone: "+1 907-555-0104", email: "hello@arcticroots.com", password: "arcticroots123", businessType: "home-based" as const, yearsInBusiness: "5", alaskaLicenseNumber: "AK-2019-LS-004", businessDescription: "Full-service landscaping for Alaska's unique climate — design, planting, and seasonal yard care.", status: "approved" as const, expiresAt: new Date("2030-09-12T00:00:00.000Z"), ownerId: "u5" },
];

async function seed() {
  console.log("Seeding categories…");
  await db.insert(categoriesTable).values(SEED_CATEGORIES).onConflictDoNothing();

  console.log("Seeding users (must run before businesses for FK)…");
  await db.insert(usersTable).values(SEED_USERS).onConflictDoNothing();

  console.log("Seeding businesses…");
  for (const b of SEED_BUSINESSES) {
    const { employees, ...row } = b;
    await db.insert(businessesTable).values(row).onConflictDoNothing();
    if (employees && employees.length > 0) {
      // Wipe & reseed employees per business so the demo set is deterministic.
      await db.execute(sql`DELETE FROM business_employees WHERE business_id = ${b.id}`);
      await db.insert(businessEmployeesTable).values(
        employees.map((e) => ({ businessId: b.id, specialty: e.specialty ?? null }))
      );
    }
  }

  console.log("Seeding services + options + reviews…");
  for (const s of SEED_SERVICES) {
    const { options, reviews, ...row } = s;
    await db.insert(servicesTable).values(row).onConflictDoNothing();
    if (options.length > 0) {
      await db.insert(serviceOptionsTable).values(options.map((o) => ({ ...o, serviceId: s.id }))).onConflictDoNothing();
    }
    if (reviews.length > 0) {
      await db.insert(serviceReviewsTable).values(reviews.map((r) => ({ ...r, serviceId: s.id }))).onConflictDoNothing();
    }
  }

  console.log("Hashing biz account passwords + seeding biz accounts…");
  const hashedBizAccounts = await Promise.all(
    SEED_BIZ_ACCOUNTS_PLAINTEXT.map(async ({ password, ...rest }) => ({
      ...rest,
      passwordHash: await bcrypt.hash(password, BCRYPT_COST),
    })),
  );
  // Upsert so existing demo rows (which may still hold plaintext from earlier
  // seeds) get their passwordHash refreshed to a real bcrypt hash.
  for (const row of hashedBizAccounts) {
    await db
      .insert(bizAccountsTable)
      .values(row)
      .onConflictDoUpdate({
        target: bizAccountsTable.id,
        set: { passwordHash: row.passwordHash, ownerId: row.ownerId },
      });
  }

  console.log("Seed complete.");
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
