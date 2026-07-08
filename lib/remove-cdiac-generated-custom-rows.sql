-- Removes the one-off CDIAC block that was accidentally stored as K-12 custom rows.
-- Run this in the Supabase SQL Editor for the workbook project.

begin;

drop table if exists tmp_generated_cdiac_custom_rows;
drop table if exists tmp_generated_cdiac_block_start;

create temporary table tmp_generated_cdiac_block_start on commit drop as
select min(row_order) as row_order
from workbook_custom_rows
where module = 'k12-targets'
  and (
    title = 'CDIAC Issuer Records'
    or fields ->> 'District' = 'CDIAC Issuer Records'
  );

create temporary table tmp_generated_cdiac_custom_rows on commit drop as
select id
from workbook_custom_rows
where module = 'k12-targets'
  and (
    row_order >= (select row_order from tmp_generated_cdiac_block_start)
    or subtitle = 'CDIAC import'
    or fields ->> 'Area' = 'CDIAC import'
  );

delete from update_suggestions
where module = 'k12-targets'
  and record_id in (select id from tmp_generated_cdiac_custom_rows);

delete from workbook_field_values
where module = 'k12-targets'
  and record_id in (select id from tmp_generated_cdiac_custom_rows);

delete from workbook_custom_rows
where id in (select id from tmp_generated_cdiac_custom_rows);

commit;
