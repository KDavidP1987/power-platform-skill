# Gold: facts, dimensions and a daily snapshot for the report; then reframe the Direct Lake model
# so the report shows this run (without the reframe it keeps serving the previous frame).
# The snapshot is append-only by day: each run replaces only today's rows, so history accumulates.
#
# Template: replace {PREFIX}/{prefix} once; fill the selects and STATUSES from silver.
from datetime import datetime
from zoneinfo import ZoneInfo
from pyspark.sql import functions as F

WS = "{{workspaceId}}"
SILVER = "{{id:Lakehouse:{PREFIX}_Silver}}"
GOLD = "{{id:Lakehouse:{PREFIX}_Gold}}"
MODEL = "{PREFIX} Model"
TIMEZONE = "{{var:timezone}}"
STATUSES = ["New", "Open", "Closed"]           # every status, so a zero day is a row, not a gap


def path(lakehouse, table):
    return f"abfss://{WS}@onelake.dfs.fabric.microsoft.com/{lakehouse}/Tables/{table}"


today = datetime.now(ZoneInfo(TIMEZONE)).date()
print("as of", today)

record = spark.read.format("delta").load(path(SILVER, "silver_record"))

fact_record = record.select(
    "record_id", "record_name", "status", "due_on",
    F.col("is_overdue").cast("int").alias("is_overdue"), "days_overdue", "as_of_date",
)

counts = record.groupBy("status").agg(F.count("*").cast("int").alias("record_count"))
statuses = spark.createDataFrame([(s,) for s in STATUSES], "status string")
snapshot = statuses.join(counts, "status", "left").select(
    F.lit(today.isoformat()).cast("date").alias("snapshot_date"), "status",
    F.coalesce("record_count", F.lit(0)).alias("record_count"))

for name, df in [("fact_record", fact_record)]:
    df.write.format("delta").mode("overwrite").option("overwriteSchema", "true").save(path(GOLD, name))

snap_path = path(GOLD, "snapshot_status_daily")
try:
    spark.read.format("delta").load(snap_path).limit(1).count()
    exists = True
except Exception:
    exists = False
writer = snapshot.write.format("delta").mode("overwrite")
if exists:
    writer = writer.option("replaceWhere", f"snapshot_date = '{today.isoformat()}'")
writer.save(snap_path)

for name in ["fact_record", "snapshot_status_daily"]:
    print(name, spark.read.format("delta").load(path(GOLD, name)).count(), "rows")

# Reframe the model. A missing model is reported, not ignored: the report would be stale.
import time
import sempy.fabric as fabric
if MODEL in set(fabric.list_datasets(workspace=WS)["Dataset Name"]):
    request_id = fabric.refresh_dataset(dataset=MODEL, workspace=WS, refresh_type="full")
    status = "Unknown"
    for _ in range(60):
        status = fabric.get_refresh_execution_details(dataset=MODEL, refresh_request_id=request_id, workspace=WS).status
        if status not in ("Unknown", "NotStarted", "InProgress"):
            break
        time.sleep(10)
    print("model refresh:", MODEL, status)
    if status != "Completed":
        raise RuntimeError(f"model refresh ended {status}")
else:
    print("MODEL NOT FOUND, NOT REFRESHED:", MODEL)
