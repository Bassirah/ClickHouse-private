# Sample files for Import data: `hr.staff`

Files to try the import of the web console (**Import data**, or the **Import data** tab of a table) with the table
`hr.staff` of the demo kit (`../demo/README.md`):

```sql
CREATE TABLE hr.staff (employee_id UInt32, name String, department LowCardinality(String), branch LowCardinality(String),
    title String, salary UInt32, email String, national_id String) ENGINE = MergeTree ORDER BY employee_id
```

The demo has the employees 1 to 400. Each file has its own range of `employee_id`, so that after an import you can tell
which file the rows came from:

```sql
SELECT intDiv(employee_id - 1, 50) * 50 + 1 AS first_id, count() FROM hr.staff WHERE employee_id > 1000 GROUP BY first_id ORDER BY first_id
```

The departments (finance, engineering, sales, hr) and branches (london, paris, berlin, new_york) are those of the demo,
so the imported rows also follow its Data Access Policies: Dana, for example, sees only the finance rows.

## One file per format

Each has 50 employees. Choose the file: the format is chosen from the extension.

| File | Format | Employees | What it shows |
|---|---|---|---|
| `staff.csv` | CSV with a header row (`CSVWithNames`) | 1001–1050 | The usual case: columns by name, types inferred from the text (`Nullable(Int64)`, `Nullable(String)`; change them for a new table). |
| `staff.tsv` | TSV with a header row (`TSVWithNames`) | 1051–1100 | Tab-separated values. |
| `staff.jsonl` | JSON, one object per line (`JSONEachRow`) | 1101–1150 | JSON lines. |
| `staff.parquet` | Parquet | 1151–1200 | The columns and their exact types come from the footer of the file: `UInt32` for `employee_id` and `salary`, without `Nullable`. |
| `staff.avro` | Avro | 1201–1250 | The columns come from the schema of the file (Avro has no unsigned integers: `Int32`). |
| `staff.arrow` | Arrow (IPC file) | 1251–1300 | Arrow file format (also `.feather`). |
| `staff.arrows` | Arrow (IPC stream) | 1301–1350 | Arrow stream format. |
| `staff_no_header.csv` | CSV without a header row (`CSV`) | 1351–1400 | Choose **CSV without a header row**: the columns are matched by position, in the order of the table. Into a new table, the columns are named `c1`, `c2`, ...: rename them before the import. |

## Edge cases

| File | Employees | What to expect |
|---|---|---|
| `staff_special_characters.csv` | 1401–1410 | Values with commas, double and single quotes, a line break inside a quoted value (1404), accents, Vietnamese and Polish letters, an emoji, and leading and trailing spaces (1410, kept as they are). All of them arrive unchanged. |
| `staff_missing_columns.jsonl` | 1411–1420 | No `title` and no `national_id`. Into `hr.staff`, those columns get their defaults (empty strings). Into a new table, the table has only the six columns of the file. |
| `staff_extra_and_reordered_columns.csv` | 1421–1430 | The columns in another order, and an extra column `hire_date`. Into `hr.staff`, the columns are matched by name, and `hire_date` is ignored. Into a new table, `hire_date` is inferred as a date (`Nullable(Date)`). |
| `staff_bad_values.csv` | 1431–1433 | A `salary` of `n/a` (row 2) and `-5` (row 3) for a `UInt32` column. The import into `hr.staff` is refused with `Cannot parse input ... (at row 2)`, and **no row is inserted**, not even the valid first one. Into a new table, `salary` is inferred as text (`String`), and the three rows import. |
| `staff_20000_rows.parquet` | 1501–21500 | 20,000 employees (about 480 KB): more rows than the preview shows; the whole file is uploaded and inserted. |

## Try it

1. Sign in as `default`, and open **Import data** (or **Tables → hr.staff → Import data**).
2. Choose a file. The page shows the format, the columns with their types, and the first rows.
3. Choose **An existing table** → `hr` → `staff`, and **Review import**. The review shows the `INSERT` statement; apply
   it.
4. Check the rows on the **Data** tab of `hr.staff`, for example with the filter `employee_id` **is greater than**
   `1000`.

To import into a new table instead, choose **A new table** and a name, change the types if needed, and choose the
sorting key (`employee_id`).

To remove the imported rows afterwards:

```sql
DELETE FROM hr.staff WHERE employee_id > 1000
```

## Regenerating the files

The files were made with `clickhouse local` from the same value lists as `../demo/config/demo.sql`: the employee
`1000 + n`, for example `SELECT ... FROM numbers(50) INTO OUTFILE 'staff.csv' FORMAT CSVWithNames`. Every file was
checked with `INSERT INTO <a table like hr.staff> FROM INFILE ... FORMAT ...`, which runs the same insert as the
console.
