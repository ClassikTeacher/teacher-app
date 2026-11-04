-- M1-08 review: presentation category, stricter invariants that M5-01 (signature detection) relies on.
ALTER TABLE file_type DROP CONSTRAINT file_type_category_check;
ALTER TABLE file_type ADD CONSTRAINT file_type_category_check
  CHECK (category IN ('image', 'document', 'spreadsheet', 'presentation', 'audio', 'video', 'archive', 'other'));
UPDATE file_type SET category = 'presentation' WHERE ext = 'pptx';
ALTER TABLE file_type ADD CONSTRAINT file_type_ext_check CHECK (ext ~ '^[a-z0-9]{1,10}$');
ALTER TABLE file_type ADD CONSTRAINT file_type_mime_check CHECK (mime ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$');
