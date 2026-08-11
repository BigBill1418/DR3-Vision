# MyMRC discovery — 2026-07-22

_ADR-0057 Phase 0 (D6). Inaugural enumeration of every Salesforce object visible to
the DR3 admin account. Portal: `https://mrc-us.my.site.com` · account: `dr3-admin`._

**Objects discovered:** 4

## Catalog

| Object                          | List views | Columns | Record count                         | Fields captured |
| ------------------------------- | ---------- | ------: | ------------------------------------ | --------------: |
| `Haul_Request__c`               | 2          |      12 | ≥ 79 (windowed — page not complete)  |              52 |
| `Materials__c`                  | 2          |       7 | ≥ 100 (windowed — page not complete) |              27 |
| `Dock_Availability_Schedule__c` | 1          |       8 | 14 (exact)                           |              14 |
| `Unknown`                       | 1          |       2 | 0 (exact)                            |               0 |

## `Haul_Request__c`

- **Key prefix:** `a2K`
- **List views:** "Docking Appointments (RC)", "Consumer Drop-Off (RC)"
- **Record count:** ≥ 79 (windowed — page not complete)
- **Sample record id:** `a2KUJ00000FeFMH2A3`
- **List columns (12):** `Recycling_Center_Lookup__r.Name`, `Docking_Appointment_Time__c`, `Docking_Appointment_Dock_Door__c`, `Docking_Appointment_Date__c`, `Rate_ID__c`, `Docking_Appointment_Id__c`, `Status__c`, `Name`, `Unpaid_Consumer_Drop_Off_Units__c`, `CreatedBy.Name`, `Collective_Incentive_Unit_Payments__c`, `Recycler_Reported_Delivery_Date__c`
- **Detail field set (52):** `Actual_Pickup_Date__c`, `Bill_of_Lading_Number__c`, `Cancellation_Date__c`, `Cancelled_By__c`, `Cancelled_By__r`, `Collection_Site_Unit_Count__c`, `Collection_Site__c`, `Collection_Source__c`, `Collective_Incentive_Unit_Payments__c`, `Commodity__c`, `Container_Type__c`, `CreatedBy`, `CreatedById`, `CreatedDate`, `Docking_Appointment_Date__c`, `Docking_Appointment_Dock_Door__c`, `Docking_Appointment_Id__c`, `Docking_Appointment_Time__c`, `Docking_Appointment__c`, `Docking_Appointment__r`, `Employee_Overseeing_Unload__c`, `Id`, `LastModifiedBy`, `LastModifiedById`, `LastModifiedDate`, `MRC_Comment_for_Recyclers__c`, `Name`, `Number_of_Attached_Files__c`, `Other_Collection_Site__c`, `Pickup_Address__c`, `Rate_ID__c`, `Recycler_Non_Program_Unit_Count__c`, `Recycler_Program_Unit_Count__c`, `Recycler_Reported_Arrival_Time__c`, `Recycler_Reported_Delivery_Date__c`, `Recycler_Reported_Departure_Time__c`, `Recycler_Review_Feedback__c`, `Recycler_Review_Status__c`, `Recycler_Reviewed__c`, `Recycler_Weight__c`, `Recycling_Center_Lookup__c`, `Recycling_Center_Lookup__r`, `Status__c`, `SystemModstamp`, `Transporter_Reported_Arrival_Time__c`, `Transporter_Reported_Delivery_Date__c`, `Transporter_Reported_Departure_Time__c`, `Transporter__c`, `Type__c`, `Unit_Count_at_Unload__c`, `Unpaid_Consumer_Drop_Off_Units__c`, `Weight_Ticket_Number__c`

> **Note added 2026-08-10 (ADR-0089).** `Recycler_Reported_Delivery_Date__c` — catalogued
> above in BOTH the 12 list columns and the 52-field detail set, the day before the ADR-0059
> spec was written — is the **TRUE delivery date**. `Docking_Appointment_Date__c` is
> **scheduling only**. Ingestion keyed on the wrong one of these two for 18 days, dropping
> every route-collection haul from the live path. This document was right and was not read;
> that is the lesson worth keeping.

## `Materials__c`

- **Key prefix:** `a2L`
- **List views:** "All Active Processed Materials", "All Active Outbound Materials"
- **Record count:** ≥ 100 (windowed — page not complete)
- **Sample record id:** `a2LUJ000001N4gf2AC`
- **List columns (7):** `BOL_ID__c`, `Processed_Date__c`, `CreatedBy.Name`, `Entry_Date__c`, `Account__r.Name`, `Name`, `Outbound_Vendor_Name__c`
- **Detail field set (27):** `Account__c`, `Account__r`, `BOL_ID__c`, `CreatedBy`, `CreatedById`, `CreatedDate`, `Entry_Date__c`, `Id`, `LastModifiedBy`, `LastModifiedById`, `LastModifiedDate`, `MRC_Comment__c`, `Materials_Status__c`, `Name`, `Number_of_Attached_Files__c`, `Number_of_Cutting_Employees__c`, `Number_of_Non_Program_Units__c`, `Number_of_Program_Units__c`, `Processed_Date__c`, `RecordTypeId`, `Record_Locked__c`, `Review_Status__c`, `SystemModstamp`, `Type__c`, `Unlock_Record__c`, `User_Review_Feedback__c`, `User_Reviewed__c`

## `Dock_Availability_Schedule__c`

- **Key prefix:** `a1t`
- **List views:** "Active Availability Schedules (RC)"
- **Record count:** 14 (exact)
- **Sample record id:** `a1tUJ000002hSr7YAE`
- **List columns (8):** `Number_of_Available_Appointments__c`, `Day_of_Week__c`, `Dock_Door__c`, `Slot_Start_Time__c`, `Slot_End_Time__c`, `Status__c`, `Name`, `Container_Type__c`
- **Detail field set (14):** `Availability_Start_Date__c`, `Container_Type__c`, `CreatedDate`, `Day_of_Week__c`, `Dock_Door__c`, `Id`, `LastModifiedById`, `LastModifiedDate`, `Name`, `Number_of_Available_Appointments__c`, `Slot_End_Time__c`, `Slot_Start_Time__c`, `Status__c`, `SystemModstamp`

## `Unknown`

- **List views:** "Recently Viewed"
- **Record count:** 0 (exact)
- **Sample record id:** (no detail captured)
- **List columns (2):** `Outbound_Vendor_Name__c`, `Name`
- **Detail field set (0):** (none)

## sObjects metadata probe (`/services/data/vNN/sobjects/`)

- **Status:** HTTP 401 — not reachable
- **Note:** metadata API not permitted for this session (expected for Experience Cloud portal users)
