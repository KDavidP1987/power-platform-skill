# Silver: cleaned, typed, choices as labels, one row per business record.
# Reads {PREFIX}_Bronze (Dataverse tables as landed by the dataflow), overwrites {PREFIX}_Silver.
# "Today" is the business calendar date in TIMEZONE - the same day the app's flows use - so an
# "overdue" figure here and in an email agree.
#
# Template: replace {PREFIX}/{prefix} once; fill CHOICES and the select() lists from
# dataverse/tables.json. fabric.py deploy resolves the {{...}} ids.
from datetime import datetime
from zoneinfo import ZoneInfo
from pyspark.sql import functions as F

WS = "{{workspaceId}}"
BRONZE = "{{id:Lakehouse:{PREFIX}_Bronze}}"
SILVER = "{{id:Lakehouse:{PREFIX}_Silver}}"
TIMEZONE = "{{var:timezone}}"


def path(lakehouse, table):
    return f"abfss://{WS}@onelake.dfs.fabric.microsoft.com/{lakehouse}/Tables/{table}"


# Choice values from dataverse/tables.json: option N of a choice is optionValuePrefix x 10000 + N
# (N from 0). Labels here, never numbers, downstream.
CHOICES = {
    "{prefix}_status": {0: "New", 1: "Open", 2: "Closed"},          # TODO: + optionValuePrefix * 10000
}


def label(col):
    mapping = CHOICES[col]
    m = F.create_map(*[x for k, v in mapping.items() for x in (F.lit(k), F.lit(v))])
    return F.when(F.col(col).isNull(), F.lit(None).cast("string")).otherwise(F.coalesce(m[F.col(col)], F.lit("Unknown")))


today = datetime.now(ZoneInfo(TIMEZONE)).date()
today_col = F.lit(today.isoformat()).cast("date")
print("as of", today)

# One block per table. Lower-case GUIDs (Dataverse returns them upper-case in some paths), trim
# text, date-only columns to_date, statecode 0 = active.
record = spark.read.format("delta").load(path(BRONZE, "{prefix}_record")).select(
    F.lower("{prefix}_recordid").alias("record_id"),
    F.trim("{prefix}_name").alias("record_name"),
    label("{prefix}_status").alias("status"),
    F.to_date("{prefix}_dueon").alias("due_on"),
    F.col("createdon").alias("created_on"),
    F.col("modifiedon").alias("modified_on"),
    (F.col("statecode") == 0).alias("is_active"),
)

# Business rules belong here, once, named after the brief's words; gold and the report only read them.
record = (
    record
    .withColumn("is_overdue", (F.col("status") == "Open") & F.col("due_on").isNotNull() & (F.col("due_on") < today_col))
    .withColumn("days_overdue", F.when(F.col("is_overdue"), F.datediff(today_col, "due_on")).otherwise(F.lit(0)))
    .withColumn("as_of_date", today_col)
)

for name, df in [("silver_record", record)]:
    df.write.format("delta").mode("overwrite").option("overwriteSchema", "true").save(path(SILVER, name))
    print(name, spark.read.format("delta").load(path(SILVER, name)).count(), "rows")
